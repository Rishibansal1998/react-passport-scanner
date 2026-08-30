export type CandidatePair = [string, string];

export type CrossValidationLike = {
  score: number;
  matched?: {
    surname?: boolean;
    givenNames?: boolean;
    passportNumber?: boolean;
    dateOfBirth?: boolean;
    dateOfExpiry?: boolean;
    nationality?: boolean;
  };
};

export type MRZCandidateScoreInput = {
  candidate: CandidatePair;
  rawMRZOCRText: string;
  fullPageOCRText: string;
  td3Valid: boolean;
  cross?: CrossValidationLike | null;
};

export type MRZCandidateScore = {
  total: number;
  td3Valid: boolean;
  breakdown: {
    td3: number;
    name: number;
    identityFields: number;
    filler: number;
    rawOCRPreservation: number;
    crossValidation: number;
  };
  suspicious: {
    trailingGarbage: number;
    repeatedConfusions: number;
  };
};

function compact(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9<]/g, "");
}

function line1NameField(line1: string): string {
  return line1.slice(5, 44);
}

function rawOCRLines(rawOCRText: string): string[] {
  return rawOCRText
    .toUpperCase()
    .split(/\r?\n/)
    .map(line => compact(line))
    .filter(Boolean);
}

function normalizedFullPageText(fullPageOCRText: string): string {
  return fullPageOCRText
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function positionalSimilarity(a: string, b: string): number {
  const aa = compact(a);
  const bb = compact(b);

  if (!aa || !bb) return 0;

  const length = Math.min(aa.length, bb.length);
  if (!length) return 0;

  let same = 0;

  for (let i = 0; i < length; i++) {
    if (aa[i] === bb[i]) {
      same++;
    }
  }

  return same / Math.max(aa.length, bb.length);
}

function candidateGivenNames(line1: string): string[] {
  const field = line1NameField(line1);
  const separator = field.indexOf("<<");

  if (separator < 0) return [];

  return field
    .slice(separator + 2)
    .replace(/<+$/g, "")
    .split("<")
    .map(value => value.trim())
    .filter(Boolean);
}

function candidateSurname(line1: string): string {
  const field = line1NameField(line1);
  const separator = field.indexOf("<<");

  if (separator < 0) {
    return field.replace(/<+/g, "").trim();
  }

  return field
    .slice(0, separator)
    .replace(/<+/g, "")
    .trim();
}

function containsNameToken(
  fullPageOCRText: string,
  token: string
): boolean {
  const target = token
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (target.length < 3) return false;

  const words = fullPageOCRText
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);

  return words.some(word => {
    if (word === target) return true;

    // Accept a very small OCR difference only.
    if (
      target.length >= 5 &&
      Math.abs(word.length - target.length) <= 1
    ) {
      let same = 0;
      const length = Math.min(word.length, target.length);

      for (let i = 0; i < length; i++) {
        if (word[i] === target[i]) same++;
      }

      return same / Math.max(word.length, target.length) >= 0.9;
    }

    // Catch a one-character prefix/suffix OCR error:
    // KTESTER vs TESTER, TESTERK vs TESTER.
    if (
      word.length === target.length + 1 &&
      (
        word.slice(1) === target ||
        word.slice(0, -1) === target
      )
    ) {
      return true;
    }

    return false;
  });
}

function nameOCRAgreement(
  line1: string,
  fullPageOCRText: string
): number {
  const surname = candidateSurname(line1);
  const givenNames = candidateGivenNames(line1);

  if (!surname && !givenNames.length) return 0;

  const surnameMatched =
    surname.length >= 3 &&
    containsNameToken(
      fullPageOCRText,
      surname
    );

  const givenMatched =
    givenNames.filter(name =>
      containsNameToken(
        fullPageOCRText,
        name
      )
    ).length;

  const totalGiven = givenNames.length;

  if (
    surnameMatched &&
    totalGiven > 0 &&
    givenMatched === totalGiven
  ) {
    return 1;
  }

  if (
    surnameMatched ||
    givenMatched > 0
  ) {
    return 0.6;
  }

  /*
   * Important:
   * Do NOT use 0.25 merely because a token resembles
   * another token. That can incorrectly reward KTESTER.
   *
   * A candidate like KTESTER should be penalized when
   * TESTER is present in the full-page OCR, but KTESTER
   * itself is not.
   */
  return 0;
}

function nameLeadingNoisePenalty(
  line1: string,
  fullPageOCRText: string
): number {
  const nameField = line1NameField(line1);
  const separator = nameField.indexOf("<<");

  if (separator < 0) return 0;

  const givenField = nameField
    .slice(separator + 2)
    .replace(/<+$/g, "");

  if (!givenField) return 0;

  const fullText =
    normalizedFullPageText(
      fullPageOCRText
    );

  const words = givenField
    .split("<")
    .filter(Boolean);

  let penalty = 0;

  for (const word of words) {
    if (word.length < 4) continue;

    const withoutFirst = word.slice(1);
    const withoutLast = word.slice(0, -1);

    const exact =
      containsNameToken(
        fullText,
        word
      );

    if (exact) continue;

    const leadingNoise =
      containsNameToken(
        fullText,
        withoutFirst
      );

    const trailingNoise =
      containsNameToken(
        fullText,
        withoutLast
      );

    if (leadingNoise || trailingNoise) {
      penalty += 30;
    }
  }

  return penalty;
}

function meaningfulNamePart(line1: string): string {
  const field = line1NameField(line1);

  const separator = field.indexOf("<<");

  if (separator >= 0) {
    return (
      field.slice(0, separator + 2) +
      field
        .slice(separator + 2)
        .replace(/<+$/g, "")
    );
  }

  return field.replace(/<+$/g, "");
}

function fillerMetrics(line1: string): {
  trailingGarbage: number;
  repeatedConfusions: number;
  cleanFillerBonus: number;
} {
  const field = line1NameField(line1);

  const fillerStart =
    field.search(/<{3,}/);

  if (fillerStart < 0) {
    return {
      trailingGarbage: 0,
      repeatedConfusions: 0,
      cleanFillerBonus: 0,
    };
  }

  const tail = field.slice(fillerStart);

  const trailingGarbage =
    (tail.match(/[A-Z0-9]/g) || [])
      .length;

  const repeatedConfusions =
    (tail.match(/[KLI1]{2,}/g) || [])
      .join("")
      .length;

  const cleanFillerBonus =
    trailingGarbage === 0
      ? 30
      : Math.max(
          0,
          10 - trailingGarbage * 3
        );

  return {
    trailingGarbage,
    repeatedConfusions,
    cleanFillerBonus,
  };
}

function nameQuality(line1: string): number {
  const field = line1NameField(line1);
  let score = 0;

  if (field.includes("<<")) {
    score += 15;
  }

  const meaningful =
    meaningfulNamePart(line1);

  const letters =
    (meaningful.match(/[A-Z]/g) || [])
      .length;

  score += Math.min(
    letters * 1.5,
    36
  );

  const repeated =
    (meaningful.match(/[KLI1]{3,}/g) || [])
      .join("")
      .length;

  score -= repeated * 3;

  return Math.max(0, score);
}

function identityFieldEvidence(
  candidate: CandidatePair,
  rawMRZOCRText: string
): number {
  const line2 = candidate[1];
  const lines = rawOCRLines(
    rawMRZOCRText
  );

  if (
    !line2 ||
    line2.length !== 44
  ) {
    return 0;
  }

  const passport =
    line2.slice(0, 9);

  const nationality =
    line2.slice(10, 13);

  const dob =
    line2.slice(13, 19);

  const expiry =
    line2.slice(21, 27);

  const raw = lines.join("");

  let score = 0;

  if (
    passport &&
    raw.includes(passport)
  ) {
    score += 12;
  }

  if (
    nationality &&
    raw.includes(nationality)
  ) {
    score += 5;
  }

  if (
    dob &&
    raw.includes(dob)
  ) {
    score += 8;
  }

  if (
    expiry &&
    raw.includes(expiry)
  ) {
    score += 8;
  }

  return score;
}

function rawOCRPreservation(
  candidate: CandidatePair,
  rawMRZOCRText: string
): number {
  const lines =
    rawOCRLines(
      rawMRZOCRText
    );

  if (lines.length < 2) {
    return 0;
  }

  const line1Score =
    positionalSimilarity(
      candidate[0],
      lines[0]
    );

  const line2Score =
    positionalSimilarity(
      candidate[1],
      lines[1]
    );

  return (
    line1Score * 8 +
    line2Score * 14
  );
}

export function scoreMRZCandidate(
  input: MRZCandidateScoreInput
): MRZCandidateScore {
  const {
    candidate,
    rawMRZOCRText,
    fullPageOCRText,
    td3Valid,
    cross,
  } = input;

  /*
   * IMPORTANT:
   *
   * Name agreement must use FULL-PAGE OCR.
   * Raw MRZ OCR is intentionally noisy, so comparing
   * KTESTER against the MRZ OCR itself would never detect
   * the extra K.
   */
  const ocrNameAgreement =
    nameOCRAgreement(
      candidate[0],
      fullPageOCRText
    );

  const nameAgreementScore =
    ocrNameAgreement * 30;

  const leadingNoisePenalty =
    nameLeadingNoisePenalty(
      candidate[0],
      fullPageOCRText
    );

  const filler =
    fillerMetrics(
      candidate[0]
    );

  const crossMatched =
    cross?.matched ?? {};

  const nameCross =
    (crossMatched.surname
      ? 12
      : 0) +
    (crossMatched.givenNames
      ? 12
      : 0);

  const identityCross =
    (crossMatched.passportNumber
      ? 10
      : 0) +
    (crossMatched.dateOfBirth
      ? 6
      : 0) +
    (crossMatched.dateOfExpiry
      ? 6
      : 0) +
    (crossMatched.nationality
      ? 3
      : 0);

  const crossValidation =
    nameCross +
    identityCross +
    Math.min(
      Math.max(
        cross?.score ?? 0,
        0
      ),
      40
    );

  const breakdown = {
    td3:
      td3Valid
        ? 1000
        : 0,

    name:
      nameQuality(
        candidate[0]
      ) +
      nameCross +
      nameAgreementScore -
      leadingNoisePenalty,

    identityFields:
      identityFieldEvidence(
        candidate,
        rawMRZOCRText
      ) +
      identityCross,

    filler:
      filler.cleanFillerBonus -
      filler.trailingGarbage * 12 -
      filler.repeatedConfusions * 4,

    rawOCRPreservation:
      rawOCRPreservation(
        candidate,
        rawMRZOCRText
      ),

    crossValidation,
  };

  const total =
    breakdown.td3 +
    breakdown.name +
    breakdown.identityFields +
    breakdown.filler +
    breakdown.rawOCRPreservation +
    breakdown.crossValidation;

  return {
    total,
    td3Valid,
    breakdown,
    suspicious: {
      trailingGarbage:
        filler.trailingGarbage,
      repeatedConfusions:
        filler.repeatedConfusions,
    },
  };
}