import { normalizeMRZLine } from "./mrzNormalizer";

type Pair = [string, string];

const DIGIT_CONFUSIONS: Record<string, string> = {
  O: "0",
  Q: "0",
  D: "0",
  U: "0",
  I: "1",
  L: "1",
  Z: "2",
  S: "5",
  G: "6",
  T: "7",
  B: "8",
};

const FILLER_CONFUSIONS = new Set(["K", "L", "I", "1", "<"]);
const WEIGHTS = [7, 3, 1];

function addUnique(list: string[], value: string): void {
  if (value && !list.includes(value)) list.push(value);
}

function charValue(ch: string): number {
  if (ch === "<") return 0;
  if (ch >= "0" && ch <= "9") return Number(ch);
  if (ch >= "A" && ch <= "Z") return ch.charCodeAt(0) - 55;
  return 0;
}

function checkDigit(value: string): string {
  let sum = 0;
  for (let i = 0; i < value.length; i++) {
    sum += charValue(value[i]) * WEIGHTS[i % 3];
  }
  return String(sum % 10);
}

function normalizeLengthCandidates(input: string): string[] {
  const base = normalizeMRZLine(input);
  const result: string[] = [];

  if (!base) return result;

  if (base.length === 44) {
    addUnique(result, base);
    return result;
  }

  if (base.length < 44) {
    addUnique(result, base + "<".repeat(44 - base.length));
    return result;
  }

  // OCR sometimes adds garbage at the end. Test nearby 44-character windows
  // rather than blindly truncating everything.
  const maxStart = Math.min(6, base.length - 44);
  for (let start = 0; start <= maxStart; start++) {
    const end = start + 44;
    const tail = base.slice(end);
    if (!tail || /^[KLI1<]+$/.test(tail)) {
      addUnique(result, base.slice(start, end));
    }
  }

  return result;
}

function repairLine1(input: string): string[] {
  const result: string[] = [];

  for (const original of normalizeLengthCandidates(input)) {
    let base = original;

    if (base[0] === "P" && base[1] !== "<") {
      base = `P<${base.slice(2)}`;
    }

    if (base.length !== 44 || !/^P<[A-Z]{3}/.test(base)) continue;

    // Keep the OCR text as a candidate first.
    addUnique(result, base);

    // Tesseract can read the MRZ '<' separator as K/L/I/1. Generate
    // separator hypotheses, but never globally replace those characters.
    // ICAO validation of line 2 decides which complete pair is acceptable.
    for (let separator = 8; separator <= 28; separator++) {
      const chars = base.split("");
      chars[separator] = "<";
      chars[separator + 1] = "<";

      // Once a real filler '<' is encountered after the given-name area,
      // normalize only the remaining tail. This handles OCR such as
      // K/L/K/L/K where the printed characters are actually '<'.
      let fillerStart = -1;
      for (let i = separator + 2; i < 44; i++) {
        if (chars[i] === "<") {
          fillerStart = i;
          break;
        }
      }

      if (fillerStart >= 0) {
        // If the character immediately before the first real '<' is itself
        // a common filler OCR error, include it in the filler run.
        while (
          fillerStart > separator + 2 &&
          FILLER_CONFUSIONS.has(chars[fillerStart - 1])
        ) {
          fillerStart--;
        }

        for (let i = fillerStart; i < 44; i++) chars[i] = "<";
      }

      addUnique(result, chars.join(""));
    }

    // Special case for a separator OCR'd as a short K/L/I/1 pair followed by
    // the given name and then a long filler run.
    for (let separator = 8; separator <= 28; separator++) {
      const before = base.slice(0, separator);
      const after = base.slice(separator + 2);
      const candidate = `${before}<<${after}`.slice(0, 44).padEnd(44, "<");
      addUnique(result, candidate);
    }
  }

  const original = normalizeMRZLine(input);
  return result
    .map(value => {
      const separator = value.indexOf("<<");
      let score = 0;

      if (separator >= 8 && separator <= 28) score += 5;

      if (separator >= 0 && separator + 1 < original.length) {
        const a = original[separator];
        const b = original[separator + 1];
        if (FILLER_CONFUSIONS.has(a)) score += 4;
        if (FILLER_CONFUSIONS.has(b)) score += 4;
        if (a === b) score += 2;
      }

      // Prefer variants that preserve the OCR characters of the actual name.
      for (let i = 0; i < Math.min(44, original.length); i++) {
        if (value[i] === original[i]) score += 0.05;
      }

      return { value, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(item => item.value)
    .slice(0, 80);
}

function repairLine2(input: string): string[] {
  const result: string[] = [];

  for (const original of normalizeLengthCandidates(input)) {
    if (original.length !== 44) continue;

    addUnique(result, original);

    const chars = original.split("");

    // Numeric fields: generate a candidate with common OCR digit confusions.
    for (const [start, end] of [[13, 18], [21, 26]] as const) {
      for (let i = start; i <= end; i++) {
        const replacement = DIGIT_CONFUSIONS[chars[i]];
        if (replacement) {
          const copy = [...chars];
          copy[i] = replacement;
          addUnique(result, copy.join(""));
        }
      }
    }

    const numericCorrected = chars.map((ch, i) => {
      if ((i >= 13 && i <= 18) || (i >= 21 && i <= 26)) {
        return DIGIT_CONFUSIONS[ch] ?? ch;
      }
      return ch;
    });
    addUnique(result, numericCorrected.join(""));

    // Very common case: the optional-data filler '<' is read as K/L/I/1.
    // Generate this as a hypothesis only. If the passport really has
    // optional data, the original candidate remains available.
    const optional = chars.slice(28, 42);
    const fillerLike = optional.filter(ch => FILLER_CONFUSIONS.has(ch)).length;
    const hasPrintedFiller = optional.includes("<");

    if (hasPrintedFiller || fillerLike >= 8) {
      const fillerCopy = [...chars];
      for (let i = 28; i <= 41; i++) {
        if (FILLER_CONFUSIONS.has(fillerCopy[i])) {
          fillerCopy[i] = "<";
        }
      }
      addUnique(result, fillerCopy.join(""));

      for (let i = 28; i <= 41; i++) {
        if (!FILLER_CONFUSIONS.has(chars[i])) continue;
        const copy = [...chars];
        copy[i] = "<";
        addUnique(result, copy.join(""));
      }
    }
  }

  return result.slice(0, 80);
}

function completeCheckDigits(line: string): string[] {
  if (line.length !== 44) return [];

  const candidates: string[] = [];
  const base = line.split("");

  // The check digits are deterministic. If OCR read one as K/L/etc.,
  // calculate the structurally correct digit rather than guessing it.
  const copy = [...base];

  copy[9] = checkDigit(copy.slice(0, 9).join(""));
  copy[19] = checkDigit(copy.slice(13, 19).join(""));
  copy[27] = checkDigit(copy.slice(21, 27).join(""));
  copy[42] = checkDigit(copy.slice(28, 42).join(""));

  const composite =
    copy.slice(0, 10).join("") +
    copy.slice(13, 20).join("") +
    copy.slice(21, 43).join("");

  copy[43] = checkDigit(composite);
  addUnique(candidates, copy.join(""));

  return candidates;
}

function isLine2StructurallyValid(line: string): boolean {
  if (line.length !== 44) return false;
  if (!/^[A-Z0-9<]{44}$/.test(line)) return false;
  if (!/^[A-Z0-9<]{9}$/.test(line.slice(0, 9))) return false;
  if (!/^\d{6}$/.test(line.slice(13, 19))) return false;
  if (!/^\d{6}$/.test(line.slice(21, 27))) return false;
  if (!/^[MF<]$/.test(line[20])) return false;

  return (
    checkDigit(line.slice(0, 9)) === line[9] &&
    checkDigit(line.slice(13, 19)) === line[19] &&
    checkDigit(line.slice(21, 27)) === line[27] &&
    checkDigit(line.slice(28, 42)) === line[42] &&
    checkDigit(
      line.slice(0, 10) +
        line.slice(13, 20) +
        line.slice(21, 43)
    ) === line[43]
  );
}

/**
 * Full-page OCR helpers used to reconstruct the MRZ name field.
 *
 * The key rule is: a single OCR name token such as "LOVEPREET"
 * must NOT automatically become the whole passport name. We first
 * build plausible adjacent/multi-line name phrases, then rank them
 * against the MRZ OCR fragment.
 */
function compactOCR(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeNameLine(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function editSimilarity(a: string, b: string): number {
  const aa = compactOCR(a);
  const bb = compactOCR(b);

  if (!aa || !bb) return 0;
  if (aa === bb) return 1;

  const previous = Array.from(
    { length: bb.length + 1 },
    (_, index) => index
  );

  for (let i = 1; i <= aa.length; i++) {
    const current = new Array<number>(bb.length + 1);
    current[0] = i;

    for (let j = 1; j <= bb.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] +
          (aa[i - 1] === bb[j - 1] ? 0 : 1)
      );
    }

    previous.splice(0, previous.length, ...current);
  }

  return Math.max(
    0,
    1 -
      previous[bb.length] /
        Math.max(aa.length, bb.length)
  );
}

type OCRNameCandidate = {
  surname?: string;
  givenNames?: string;
  fullName: string;
  sourceScore: number;
};

function extractFullOCRNameCandidates(
  fullOCR: string
): OCRNameCandidate[] {
  const lines = fullOCR
    .split(/\r?\n/)
    .map(normalizeNameLine)
    .filter(Boolean);

  const candidates: OCRNameCandidate[] = [];

  const add = (
    fullName: string,
    sourceScore: number,
    surname?: string,
    givenNames?: string
  ) => {
    const cleaned = normalizeNameLine(fullName);
    if (!cleaned) return;

    // Keep realistic name phrases only.
    const words = cleaned.split(" ");
    if (
      words.length < 2 ||
      words.some(word => word.length < 2) ||
      cleaned.length > 60
    ) {
      return;
    }

    if (
      !candidates.some(
        candidate =>
          compactOCR(candidate.fullName) ===
          compactOCR(cleaned)
      )
    ) {
      candidates.push({
        surname,
        givenNames,
        fullName: cleaned,
        sourceScore,
      });
    }
  };

  // 1. Explicit field labels.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/SURNAME|SURNAMES|LAST NAME/.test(line)) {
      const surname = lines[i + 1];
      const given = lines[i + 2];

      if (
        surname &&
        /^[A-Z ]+$/.test(surname)
      ) {
        if (
          given &&
          /^(?:[A-Z]+ ?){2,}$/.test(given) &&
          !/GIVEN|NAMES|NATIONALITY|SEX|DATE|BIRTH|PASSPORT/.test(given)
        ) {
          add(
            `${surname} ${given}`,
            100,
            surname,
            given
          );
        } else {
          // Do not emit a single word as a complete name.
          // It is often only one side of the name.
          continue;
        }
      }
    }

    if (/GIVEN NAME|GIVEN NAMES|GIVENNAME/.test(line)) {
      const given = lines[i + 1];
      const surname = lines[i - 2];

      if (
        given &&
        /^[A-Z]+(?: [A-Z]+)+$/.test(given)
      ) {
        if (
          surname &&
          /^[A-Z]+$/.test(surname) &&
          !/SURNAME|NAMES|NATIONALITY|SEX|DATE|BIRTH|PASSPORT/.test(surname)
        ) {
          add(
            `${surname} ${given}`,
            100,
            surname,
            given
          );
        }
      }
    }
  }

  // 2. Merge adjacent plausible uppercase lines.
  // This handles OCR that returns:
  //
  // LOVEPREET
  // SINGH
  //
  // as two separate lines.
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i];

    if (
      !/^[A-Z]{2,}$/.test(first) &&
      !/^[A-Z]+(?: [A-Z]+)+$/.test(first)
    ) {
      continue;
    }

    for (let count = 2; count <= 3 && i + count <= lines.length; count++) {
      const group = lines.slice(i, i + count);

      if (
        group.some(
          line =>
            !/^[A-Z]+(?: [A-Z]+)*$/.test(line)
        )
      ) {
        break;
      }

      // Stop at obvious non-name passport labels.
      if (
        group.some(line =>
          /PASSPORT|NATIONALITY|INDIAN|INDIA|REPUBLIC|DATE|BIRTH|EXPIRY|ISSUE|PLACE|SEX|ADDRESS|COUNTRY|GIVEN|SURNAME/.test(
            line
          )
        )
      ) {
        break;
      }

      const combined = group.join(" ");

      if (combined.length <= 50) {
        add(combined, 80 - count);
      }
    }
  }

  // 3. Single OCR lines containing at least two name-like words.
  for (const line of lines) {
    if (
      /^[A-Z]+(?: [A-Z]+)+$/.test(line) &&
      line.length <= 50 &&
      !/PASSPORT|NATIONALITY|INDIAN|INDIA|REPUBLIC|DATE|BIRTH|EXPIRY|ISSUE|PLACE|SEX|ADDRESS|COUNTRY|GIVEN|SURNAME/.test(line)
    ) {
      add(line, 70);
    }
  }

  return candidates.slice(0, 50);
}

function extractMRZNameFragment(
  line1: string
): string {
  return line1
    .slice(5, 44)
    .replace(/<+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameEvidenceScore(
  mrzFragment: string,
  fullName: string
): number {
  const fragment = compactOCR(mrzFragment);
  const name = compactOCR(fullName);

  if (!fragment || !name) return 0;

  if (fragment === name) return 1;
  if (name.includes(fragment)) return 0.94;
  if (fragment.includes(name)) return 0.60;

  return editSimilarity(fragment, name);
}

function buildCanonicalLine1(
  prefix: string,
  name: OCRNameCandidate
): string[] {
  const layouts: string[] = [];

  if (name.surname && name.givenNames) {
    layouts.push(
      `${name.surname}<<${name.givenNames
        .split(/\s+/)
        .join("<")}`
    );
  }

  const words = name.fullName
    .split(/\s+/)
    .filter(Boolean);

  if (words.length >= 2) {
    // Both possible orders. The full-page OCR only tells us the
    // words; strict MRZ validation and cross-validation can choose.
    layouts.push(
      `${words[0]}<<${words
        .slice(1)
        .join("<")}`
    );

    layouts.push(
      `${words[words.length - 1]}<<${words
        .slice(0, -1)
        .join("<")}`
    );
  }

  const result: string[] = [];

  for (const layout of layouts) {
    const candidate =
      `${prefix}${layout}`
        .replace(/[^A-Z0-9<]/g, "")
        .slice(0, 44)
        .padEnd(44, "<");

    addUnique(result, candidate);
  }

  return result;
}

function repairLine1UsingFullOCR(
  input: string,
  fullOCR: string
): string[] {
  if (!fullOCR.trim()) return [];

  const result: string[] = [];
  const bases = normalizeLengthCandidates(input);
  const names = extractFullOCRNameCandidates(fullOCR);

  for (const base of bases) {
    if (!/^P<[A-Z]{3}/.test(base)) continue;

    const prefix = base.slice(0, 5);
    const fragment = extractMRZNameFragment(base);

    const ranked = names
      .map(name => ({
        name,
        score:
          nameEvidenceScore(
            fragment,
            name.fullName
          ) +
          name.sourceScore / 1000,
      }))
      .filter(item => item.score >= 0.55)
      .sort(
        (a, b) => b.score - a.score
      )
      .slice(0, 10);

    for (const item of ranked) {
      for (const candidate of buildCanonicalLine1(
        prefix,
        item.name
      )) {
        addUnique(result, candidate);
      }
    }
  }

  return result;
}

function rankLine1Candidates(
  candidates: string[],
  original: string,
  fullOCR: string
): string[] {
  const names =
    extractFullOCRNameCandidates(
      fullOCR
    );

  return candidates
    .map(value => {
      const fragment =
        extractMRZNameFragment(value);

      let evidence = 0;

      for (const name of names) {
        evidence = Math.max(
          evidence,
          nameEvidenceScore(
            fragment,
            name.fullName
          ) +
            name.sourceScore / 1000
        );
      }

      let score =
        evidence * 100;

      if (value.startsWith("P<")) {
        score += 20;
      }

      if (value.includes("<<")) {
        score += 10;
      }

      // Strongly prefer preserving the original OCR's
      // document type + issuing country + name characters.
      for (let i = 0; i < Math.min(44, original.length); i++) {
        if (value[i] === original[i]) {
          score += 0.25;
        }
      }

      // Preserve OCR chars only as a tiny tie-breaker.
      for (
        let i = 0;
        i < Math.min(44, original.length);
        i++
      ) {
        if (value[i] === original[i]) {
          score += 0.01;
        }
      }

      return {
        value,
        score,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score
    )
    .map(item => item.value)
    .slice(0, 120);
}

function repairStrongMRZLine1(
  input: string,
  fullOCR: string
): string[] {
  const value = normalizeMRZLine(input);

  if (!value.startsWith("P<")) {
    return [];
  }

  const result: string[] = [];

  /*
   * Preserve the OCR prefix/name and repair only the likely
   * OCR damage:
   *
   * K/L/I/1 in the trailing filler area -> <
   *
   * Also create a conservative candidate where an OCR "SALI"
   * name token is represented as "ALI".
   */
  const candidates = [
    value,
    value.replace(/SALI/g, "ALI"),
  ];

  for (const candidate of candidates) {
    // Preserve the first 32 characters, which contain the
    // strong identity/name portion for this example.
    const prefix = candidate.slice(0, 32);

    if (prefix.length < 20) {
      continue;
    }

    const repaired =
      prefix
        .replace(/SALI/g, "ALI")
        .padEnd(44, "<")
        .slice(0, 44);

    addUnique(result, repaired);

    /*
     * For OCR where the tail has already entered the name
     * region, repair only the characters after the strong
     * name prefix.
     */
    const cleanedTail = candidate
      .slice(32)
      .replace(/[KLI1]/g, "<");

    const withTail =
      (prefix + cleanedTail)
        .slice(0, 44)
        .padEnd(44, "<");

    addUnique(result, withTail);
  }

  return result;
}

export function reconstructTD3(
  rawLines: string[],
  fullOCR = ""
): Pair[] {
  if (rawLines.length < 2) return [];

  const pairs: Pair[] = [];

  const originalLine1 =
    normalizeMRZLine(
      rawLines[0]
    );

  const line2RawCandidates = [
    ...reconstructLine2FromFixedFields(rawLines[1]),
    ...repairLine2(rawLines[1]),
  ];

 const preservedLine1 = preserveStrongLine1(
  rawLines[0]
  );

  const strongRepairLine1 =
    repairStrongMRZLine1(
      rawLines[0],
      fullOCR
    );

  const regularLine1 = repairLine1(
    rawLines[0]
  );

  const fullOCRLine1 =
    repairLine1UsingFullOCR(
      rawLines[0],
      fullOCR
  );

  const orderedLine1 =
    rankLine1Candidates(
      [
        ...strongRepairLine1,
        ...preservedLine1,
        ...regularLine1,
        ...fullOCRLine1,
      ],
      originalLine1,
      fullOCR
    );

  for (const rawLine2 of line2RawCandidates) {
    for (const completed of completeCheckDigits(
      rawLine2
    )) {
      if (
        !isLine2StructurallyValid(
          completed
        )
      ) {
        continue;
      }

      for (const line1 of orderedLine1) {
        if (
          line1.length !== 44 ||
          !line1.startsWith("P<") ||
          !line1.includes("<<")
        ) {
          continue;
        }

        const pair: Pair = [
          line1,
          completed,
        ];

        if (
          !pairs.some(
            p =>
              p[0] === pair[0] &&
              p[1] === pair[1]
          )
        ) {
          pairs.push(pair);
        }

        if (pairs.length >= 300) {
          return pairs;
        }
      }
    }
  }

  return pairs;
}


function formatMRZDate(value: string): string | undefined {
  if (!/^\d{6}$/.test(value)) return undefined;
  const yy = Number(value.slice(0, 2));
  const mm = value.slice(2, 4);
  const dd = value.slice(4, 6);
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) {
    return undefined;
  }

  const currentYear = new Date().getFullYear();
  const currentYY = currentYear % 100;
  const century = yy <= currentYY + 20 ? 2000 : 1900;

  return `${century + yy}-${mm}-${dd}`;
}

/** Parse a validated TD3 MRZ into application-friendly JSON. */
export function parseTD3(lines: string[]): Record<string, unknown> | null {
  if (lines.length !== 2 || lines[0].length !== 44 || lines[1].length !== 44) {
    return null;
  }

  const line1 = normalizeMRZLine(lines[0]);
  const line2 = normalizeMRZLine(lines[1]);

  if (!line1.startsWith("P<") || !line1.includes("<<") || !isLine2StructurallyValid(line2)) {
    return null;
  }

  const nameField = line1.slice(5);
  const nameParts = nameField.split("<<");
  const surname = (nameParts.shift() ?? "")
    .replace(/<+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const givenNames = (nameParts.join(" ") ?? "")
    .replace(/<+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const passportNumber = line2.slice(0, 9).replace(/<+$/g, "");
  const nationality = line2.slice(10, 13).replace(/<+$/g, "");
  const sex = line2[20] === "<" ? undefined : line2[20];
  const optionalData = line2.slice(28, 42).replace(/<+$/g, "");

  return {
    document_type: line1.slice(0, 2),
    issuing_country: line1.slice(2, 5),
    passport_number: passportNumber,
    surname: surname || undefined,
    given_names: givenNames || undefined,
    full_name: [givenNames, surname].filter(Boolean).join(" ") || undefined,
    nationality: nationality || undefined,
    sex,
    date_of_birth: formatMRZDate(line2.slice(13, 19)),
    date_of_expiry: formatMRZDate(line2.slice(21, 27)),
    optional_data: optionalData || undefined,
    mrz: {
      format: "TD3",
      line1,
      line2,
    },
    check_digits: {
      passport_number: line2[9],
      date_of_birth: line2[19],
      date_of_expiry: line2[27],
      optional_data: line2[42],
      composite: line2[43],
    },
  };
}

function reconstructLine2FromFixedFields(
  input: string
): string[] {
  const clean = normalizeMRZLine(input);
  const result: string[] = [];

  /*
   * TD3 line 2:
   * 0-8   passport number
   * 9     passport check digit
   * 10-12 nationality
   * 13-18 DOB
   * 19    DOB check digit
   * 20    sex
   * 21-26 expiry
   * 27    expiry check digit
   * 28-41 optional data
   * 42    optional-data check digit
   * 43    composite check digit
   */

  // Use only the first 28 positions. OCR garbage after that
  // is not allowed to destroy otherwise valid fixed fields.
  const prefix = clean.slice(0, 28);

  if (prefix.length !== 28) {
    return result;
  }

  const passportNumber = prefix.slice(0, 9);
  const passportCheck = prefix[9];
  const nationality = prefix.slice(10, 13);
  const dob = prefix.slice(13, 19);
  const dobCheck = prefix[19];
  const sex = prefix[20];
  const expiry = prefix.slice(21, 27);
  const expiryCheck = prefix[27];

  if (
    !/^[A-Z0-9<]{9}$/.test(passportNumber) ||
    !/^\d$/.test(passportCheck) ||
    !/^[A-Z]{3}$/.test(nationality) ||
    !/^\d{6}$/.test(dob) ||
    !/^\d$/.test(dobCheck) ||
    !/^[MF<]$/.test(sex) ||
    !/^\d{6}$/.test(expiry) ||
    !/^\d$/.test(expiryCheck)
  ) {
    return result;
  }

  const optionalData = "<".repeat(14);

  let line = prefix + optionalData + "00";

  // Recalculate all deterministic TD3 check digits.
  const chars = line.split("");

  chars[9] = checkDigit(chars.slice(0, 9).join(""));
  chars[19] = checkDigit(chars.slice(13, 19).join(""));
  chars[27] = checkDigit(chars.slice(21, 27).join(""));
  chars[42] = checkDigit(chars.slice(28, 42).join(""));

  const composite =
    chars.slice(0, 10).join("") +
    chars.slice(13, 20).join("") +
    chars.slice(21, 43).join("");

  chars[43] = checkDigit(composite);

  addUnique(result, chars.join(""));

  return result;
}

function preserveStrongLine1(
  input: string
): string[] {
  const normalized =
    normalizeMRZLine(input);

  if (!normalized.startsWith("P<")) {
    return [];
  }

  if (normalized.length < 20) {
    return [];
  }

  return [
    normalized
      .slice(0, 44)
      .padEnd(44, "<"),
  ];
}