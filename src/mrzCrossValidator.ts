export type MRZCrossValidation = {
  score: number;
  matched: {
    surname: boolean;
    givenNames: boolean;
    passportNumber: boolean;
    dateOfBirth: boolean;
    dateOfExpiry: boolean;
    nationality: boolean;
  };
  extracted: {
    surname?: string;
    givenNames?: string;
    passportNumber?: string;
    dateOfBirth?: string;
    dateOfExpiry?: string;
    nationality?: string;
  };
};

function compact(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function editSimilarity(a: string, b: string): number {
  const aa = compact(a);
  const bb = compact(b);

  if (!aa || !bb) return 0;
  if (aa === bb) return 1;

  const previous = Array.from({ length: bb.length + 1 }, (_, i) => i);

  for (let i = 1; i <= aa.length; i++) {
    const current = new Array<number>(bb.length + 1);
    current[0] = i;

    for (let j = 1; j <= bb.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (aa[i - 1] === bb[j - 1] ? 0 : 1)
      );
    }

    previous.splice(0, previous.length, ...current);
  }

  return Math.max(
    0,
    1 - previous[bb.length] / Math.max(aa.length, bb.length)
  );
}

/**
 * TD3 name field:
 *
 * P<CCC
 *   ^^^
 *   name starts at position 5
 *
 * The first << separates surname from given names.
 * Everything after that first separator belongs to the given-name portion.
 */
function extractMRZName(line1: string): {
  surname: string;
  givenNames: string;
} {
  const field = line1.slice(5, 44);
  const separator = field.indexOf("<<");

  if (separator < 0) {
    return {
      surname: field.replace(/<+/g, " ").trim(),
      givenNames: "",
    };
  }

  return {
    surname: field
      .slice(0, separator)
      .replace(/<+/g, " ")
      .trim(),

    givenNames: field
      .slice(separator + 2)
      .replace(/<+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  };
}

function ocrTokens(fullOCR: string): string[] {
  return fullOCR
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2);
}

function phraseMatch(
  fullOCR: string,
  value: string,
  threshold = 0.92
): boolean {
  const target = compact(value);
  if (!target) return false;

  const tokens = ocrTokens(fullOCR);
  if (!tokens.length) return false;

  // Exact token.
  if (tokens.some(token => token === target)) {
    return true;
  }

  // Exact multi-token phrase, ignoring separators.
  for (let start = 0; start < tokens.length; start++) {
    let joined = "";

    for (
      let size = 1;
      size <= 5 && start + size <= tokens.length;
      size++
    ) {
      joined += tokens[start + size - 1];

      if (joined === target) {
        return true;
      }

      /*
       * Do not accept short one-character OCR matches or
       * loose substring matches. This prevents:
       *
       * LOVEPREET -> L
       * LOVEPREET -> L EPREET
       *
       * from being treated as a strong match.
       */
      if (
        joined.length >= Math.max(4, target.length - 2) &&
        editSimilarity(joined, target) >= threshold &&
        Math.abs(joined.length - target.length) <= 1
      ) {
        return true;
      }
    }
  }

  // A single OCR line may contain multiple words.
  const lines = fullOCR
    .toUpperCase()
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const normalized = compact(line);
    if (
      normalized === target ||
      (
        normalized.length >= Math.max(4, target.length - 2) &&
        Math.abs(normalized.length - target.length) <= 1 &&
        editSimilarity(normalized, target) >= threshold
      )
    ) {
      return true;
    }
  }

  return false;
}

function dateMatches(fullOCR: string, mrzYYMMDD: string): boolean {
  if (!/^\d{6}$/.test(mrzYYMMDD)) return false;

  const yy = mrzYYMMDD.slice(0, 2);
  const mm = mrzYYMMDD.slice(2, 4);
  const dd = mrzYYMMDD.slice(4, 6);

  const forms = [
    `${dd}${mm}${yy}`,
    `${dd}/${mm}/${yy}`,
    `${dd}/${mm}/20${yy}`,
    `${dd}-${mm}-${yy}`,
    `${dd}-${mm}-20${yy}`,
    `20${yy}${mm}${dd}`,
    `${yy}${mm}${dd}`,
  ];

  const normalizedOCR = fullOCR.toUpperCase().replace(/[^A-Z0-9]/g, "");

  return forms.some(form =>
    normalizedOCR.includes(
      form.toUpperCase().replace(/[^A-Z0-9]/g, "")
    )
  );
}

export function crossValidateTD3(
  line1: string,
  line2: string,
  fullOCR: string
): MRZCrossValidation {
  const name = extractMRZName(line1);

  const passportNumber = line2
    .slice(0, 9)
    .replace(/<+$/g, "");

  const nationality = line2
    .slice(10, 13)
    .replace(/</g, "");

  const dateOfBirth = line2.slice(13, 19);
  const dateOfExpiry = line2.slice(21, 27);

  /*
   * Stronger matching is intentional here.
   * Cross-validation must reject a candidate such as:
   *
   * L EPREET
   *
   * when the full OCR actually contains:
   *
   * LOVEPREET SINGH
   *
   * A loose substring/containment check can otherwise
   * incorrectly approve the bad candidate.
   */
  const surnameMatch = name.surname
    ? phraseMatch(fullOCR, name.surname, 0.92)
    : false;

  const givenNamesMatch = name.givenNames
    ? phraseMatch(fullOCR, name.givenNames, 0.92)
    : false;

  const passportNumberMatch =
    !!passportNumber &&
    phraseMatch(fullOCR, passportNumber, 0.95);

  const dateOfBirthMatch = dateMatches(
    fullOCR,
    dateOfBirth
  );

  const dateOfExpiryMatch = dateMatches(
    fullOCR,
    dateOfExpiry
  );

  const nationalityMatch =
    !!nationality &&
    phraseMatch(fullOCR, nationality, 1);

  let score = 0;

  /*
   * Missing name evidence is not automatically a failure,
   * because full-page OCR can miss names. But if a name is
   * present in the MRZ candidate and the full-page OCR does
   * not support it, do not award any name points.
   */
  if (name.surname) {
    score += surnameMatch ? 30 : 0;
  }

  if (name.givenNames) {
    score += givenNamesMatch ? 30 : 0;
  }

  if (passportNumber) {
    score += passportNumberMatch ? 20 : 0;
  }

  if (/^\d{6}$/.test(dateOfBirth)) {
    score += dateOfBirthMatch ? 8 : 0;
  }

  if (/^\d{6}$/.test(dateOfExpiry)) {
    score += dateOfExpiryMatch ? 8 : 0;
  }

  if (nationality) {
    score += nationalityMatch ? 4 : 0;
  }

  return {
    score,
    matched: {
      surname: surnameMatch,
      givenNames: givenNamesMatch,
      passportNumber: passportNumberMatch,
      dateOfBirth: dateOfBirthMatch,
      dateOfExpiry: dateOfExpiryMatch,
      nationality: nationalityMatch,
    },
    extracted: {
      surname: name.surname || undefined,
      givenNames: name.givenNames || undefined,
      passportNumber: passportNumber || undefined,
      dateOfBirth: dateOfBirth || undefined,
      dateOfExpiry: dateOfExpiry || undefined,
      nationality: nationality || undefined,
    },
  };
}