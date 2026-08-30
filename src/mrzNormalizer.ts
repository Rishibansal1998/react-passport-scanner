/**
 * Conservative MRZ normalization helpers.
 *
 * IMPORTANT:
 * - We do not globally replace OCR characters such as L -> <.
 * - Such replacements are only generated as candidates for TD3 validation.
 * - The final decision is made by ICAO check digits in App.tsx.
 */

export function normalizeMRZLine(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9<]/g, "");
}

function addUnique(list: string[], value: string): void {
  if (value && !list.includes(value)) {
    list.push(value);
  }
}

/**
 * Generate conservative alternatives for the first TD3 line.
 *
 * Tesseract frequently reads the MRZ filler '<' as L/I/1.
 * We only repair trailing filler and the mandatory P< prefix.
 */
function generateLine1Variants(input: string): string[] {
  const base = normalizeMRZLine(input);
  const variants: string[] = [];

  addUnique(variants, base);

  // TD3 passports start with P<. If OCR dropped the separator,
  // test the structurally required separator.
  if (base.startsWith("P") && base.length >= 2) {
    addUnique(variants, `P<${base.slice(2)}`);
  }

  if (base.startsWith("<")) {
    addUnique(variants, `P${base}`);
  }

  // OCR often reads a run of MRZ filler '<' as L/I/1.
  // Only touch a trailing run, never normal name characters.
  const trailingFiller = base.match(/[LI1]+$/);
  if (trailingFiller && trailingFiller.index !== undefined) {
    const repaired =
      base.slice(0, trailingFiller.index) +
      "<".repeat(trailingFiller[0].length);

    addUnique(variants, repaired);

    if (repaired.startsWith("P") && repaired[1] !== "<") {
      addUnique(variants, `P<${repaired.slice(2)}`);
    }
  }

  // If OCR missed one final filler character.
  if (base.length === 43) {
    addUnique(variants, `${base}<`);
  }

  // If there is one extra OCR filler character.
  if (base.length === 45 && /[<LI1]/.test(base[44])) {
    addUnique(variants, base.slice(0, 44));
  }

  return variants.slice(0, 12);
}

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

/**
 * Generate alternatives for TD3 line 2.
 *
 * Numeric fields get conservative OCR substitutions. Check digits are
 * never trusted by themselves; the final validator checks every field.
 */
function generateLine2Variants(input: string): string[] {
  const base = normalizeMRZLine(input);
  const variants: string[] = [];

  addUnique(variants, base);

  if (base.length !== 44) {
    if (base.length === 43) {
      addUnique(variants, `${base}<`);
    }

    if (base.length === 45 && /[<LI1]/.test(base[44])) {
      addUnique(variants, base.slice(0, 44));
    }

    return variants;
  }

  const numericPositions = new Set<number>();

  // Document number may be alphanumeric, so only add positions whose
  // OCR character has a very common digit confusion.
  for (let i = 0; i <= 8; i++) {
    if (DIGIT_CONFUSIONS[base[i]]) {
      numericPositions.add(i);
    }
  }

  // Date of birth.
  for (let i = 13; i <= 18; i++) {
    numericPositions.add(i);
  }

  // Date of expiry.
  for (let i = 21; i <= 26; i++) {
    numericPositions.add(i);
  }

  // One-character correction candidates.
  for (const position of numericPositions) {
    const replacement = DIGIT_CONFUSIONS[base[position]];

    if (!replacement || replacement === base[position]) {
      continue;
    }

    const chars = base.split("");
    chars[position] = replacement;
    addUnique(variants, chars.join(""));
  }

  // Candidate with all obvious numeric confusions corrected.
  const allNumericCorrected = base
    .split("")
    .map((character, index) => {
      if (!numericPositions.has(index)) {
        return character;
      }

      return DIGIT_CONFUSIONS[character] ?? character;
    })
    .join("");

  addUnique(variants, allNumericCorrected);

  return variants.slice(0, 24);
}

/**
 * Generate candidate TD3 pairs.
 *
 * These are hypotheses only. App.tsx must still run strict ICAO
 * validation before accepting one.
 */
export function generateTD3Candidates(
  rawLines: string[]
): Array<[string, string]> {
  if (rawLines.length < 2) {
    return [];
  }

  const linePairs: Array<[string, string]> = [
    [rawLines[0], rawLines[1]],
  ];

  // OCR can occasionally return the two rows in reverse order.
  if (rawLines[0] !== rawLines[1]) {
    linePairs.push([rawLines[1], rawLines[0]]);
  }

  const result: Array<[string, string]> = [];

  for (const [raw1, raw2] of linePairs) {
    const line1Variants = generateLine1Variants(raw1);
    const line2Variants = generateLine2Variants(raw2);

    for (const line1 of line1Variants) {
      for (const line2 of line2Variants) {
        if (
          !result.some(
            existing =>
              existing[0] === line1 &&
              existing[1] === line2
          )
        ) {
          result.push([line1, line2]);
        }

        if (result.length >= 96) {
          return result;
        }
      }
    }
  }

  return result;
}

/**
 * Parse a validated TD3 MRZ into JSON.
 *
 * Call this only after strict ICAO validation succeeds.
 */
export function parseTD3(
  lines: string[]
): Record<string, unknown> | null {
  if (lines.length !== 2) {
    return null;
  }

  const line1 = normalizeMRZLine(lines[0]);
  const line2 = normalizeMRZLine(lines[1]);

  if (
    line1.length !== 44 ||
    line2.length !== 44 ||
    !line1.startsWith("P<")
  ) {
    return null;
  }

  const nameField = line1.slice(5, 44);
  const nameParts = nameField.split("<<");

  const surname = (nameParts[0] ?? "")
    .replace(/<+$/g, "")
    .replace(/</g, " ")
    .trim();

  const givenNames = (nameParts[1] ?? "")
    .replace(/<+/g, " ")
    .trim();

  return {
    document_type: line1[0],
    issuing_country: line2.slice(10, 13),
    nationality: line2.slice(10, 13),
    surname,
    given_names: givenNames,
    full_name: [givenNames, surname]
      .filter(Boolean)
      .join(" ")
      .trim(),
    passport_number: line2.slice(0, 9),
    date_of_birth: line2.slice(13, 19),
    sex: line2[20] === "<" ? null : line2[20],
    date_of_expiry: line2.slice(21, 27),
    optional_data: line2.slice(28, 42),
    mrz: {
      line1,
      line2,
    },
  };
}
