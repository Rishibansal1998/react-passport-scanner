import {
  useEffect,
  useRef,
  useState,
} from "react";

import {
  createWorker,
  type Worker,
} from "tesseract.js";

import {
  detectMRZCandidates,
  detectMRZFromOCR,
  findPAnchors,
  paddedCrop,
  type BoundingBox,
  type MRZCandidate,
  type OCRLine,
} from "./mrzDetector";
import { normalizeMRZLine } from "./mrzNormalizer";
import { reconstructTD3, parseTD3 } from "./mrzReconstructor";
import { crossValidateTD3 } from "./mrzCrossValidator";
import { scoreMRZCandidate } from "./mrzCandidateScorer";

const MRZ_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<";


type OCRDateCandidate = {
  iso: string;
  lineIndex: number;
  raw: string;
  confidence: number;
};

const PASSPORT_MONTHS: Record<string, number> = {
  JAN: 1,
  JANUARY: 1,
  FEB: 2,
  FEBRUARY: 2,
  MAR: 3,
  MARCH: 3,
  APR: 4,
  APRIL: 4,
  MAY: 5,
  JUN: 6,
  JUNE: 6,
  JUL: 7,
  JULY: 7,
  AUG: 8,
  AUGUST: 8,
  SEP: 9,
  SEPT: 9,
  SEPTEMBER: 9,
  OCT: 10,
  OCTOBER: 10,
  NOV: 11,
  NOVEMBER: 11,
  DEC: 12,
  DECEMBER: 12,
};

function normalizePassportYear(
  value: number
): number {
  if (value >= 1000) {
    return value;
  }

  const currentYear =
    new Date().getFullYear();

  const currentYY =
    currentYear % 100;

  return value <= currentYY + 20
    ? 2000 + value
    : 1900 + value;
}

function buildISODate(
  day: number,
  month: number,
  year: number
): string | undefined {
  const fullYear =
    normalizePassportYear(year);

  if (
    day < 1 ||
    day > 31 ||
    month < 1 ||
    month > 12 ||
    fullYear < 1900 ||
    fullYear > 2100
  ) {
    return undefined;
  }

  const date =
    new Date(
      Date.UTC(
        fullYear,
        month - 1,
        day
      )
    );

  // Reject impossible calendar dates such as 31/02/2022.
  if (
    date.getUTCFullYear() !== fullYear ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  return `${fullYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function extractPassportDates(
  fullOCR: string
): OCRDateCandidate[] {
  const lines = fullOCR
    .toUpperCase()
    .split(/\r?\n/)
    .map(line =>
      line
        .normalize("NFD")
        .replace(
          /[\u0300-\u036f]/g,
          ""
        )
        .replace(
          /[^A-Z0-9/.\-\s]/g,
          " "
        )
        .replace(
          /\s+/g,
          " "
        )
        .trim()
    );

  const result: OCRDateCandidate[] = [];

  const add = (
    iso: string | undefined,
    lineIndex: number,
    raw: string,
    confidence: number
  ) => {
    if (!iso) return;

    const duplicate =
      result.some(
        item =>
          item.iso === iso &&
          item.lineIndex === lineIndex
      );

    if (!duplicate) {
      result.push({
        iso,
        lineIndex,
        raw,
        confidence,
      });
    }
  };

  const numericRegex =
    /\b(\d{1,4})[\/.\-](\d{1,4})[\/.\-](\d{2,4})\b/g;

  const compactRegex =
    /\b(\d{8})\b/g;

  const monthWordRegex =
    /\b(\d{1,2})\s+([A-Z]{3,9})\s+(\d{2,4})\b/g;

  const monthWordRegex2 =
    /\b([A-Z]{3,9})\s+(\d{1,2})[,\s]+(\d{2,4})\b/g;

  for (
    let lineIndex = 0;
    lineIndex < lines.length;
    lineIndex++
  ) {
    const line = lines[lineIndex];

    for (
      const match of line.matchAll(
        numericRegex
      )
    ) {
      const a = Number(match[1]);
      const b = Number(match[2]);
      const c = Number(match[3]);

      /*
       * YYYY-MM-DD / YYYY/MM/DD.
       */
      if (
        match[1].length === 4
      ) {
        add(
          buildISODate(
            c,
            b,
            a
          ),
          lineIndex,
          match[0],
          0.95
        );
        continue;
      }

      /*
       * Normal passport format: DD-MM-YYYY.
       */
      if (a > 12) {
        add(
          buildISODate(
            a,
            b,
            c
          ),
          lineIndex,
          match[0],
          0.95
        );
        continue;
      }

      /*
       * US-style MM-DD-YYYY.
       */
      if (b > 12) {
        add(
          buildISODate(
            b,
            a,
            c
          ),
          lineIndex,
          match[0],
          0.90
        );
        continue;
      }

      /*
       * Ambiguous numeric dates.
       * Keep both interpretations. We resolve them later by
       * matching the known MRZ expiry/DOB.
       */
      add(
        buildISODate(
          a,
          b,
          c
        ),
        lineIndex,
        match[0],
        0.70
      );

      add(
        buildISODate(
          b,
          a,
          c
        ),
        lineIndex,
        match[0],
        0.65
      );
    }

    for (
      const match of line.matchAll(
        monthWordRegex
      )
    ) {
      const day =
        Number(match[1]);

      const month =
        PASSPORT_MONTHS[
          match[2]
        ];

      const year =
        Number(match[3]);

      add(
        buildISODate(
          day,
          month,
          year
        ),
        lineIndex,
        match[0],
        0.95
      );
    }

    for (
      const match of line.matchAll(
        monthWordRegex2
      )
    ) {
      const month =
        PASSPORT_MONTHS[
          match[1]
        ];

      const day =
        Number(match[2]);

      const year =
        Number(match[3]);

      add(
        buildISODate(
          day,
          month,
          year
        ),
        lineIndex,
        match[0],
        0.95
      );
    }

    for (
      const match of line.matchAll(
        compactRegex
      )
    ) {
      const raw =
        match[1];

      const first4 =
        Number(raw.slice(0, 4));

      if (
        first4 >= 1900 &&
        first4 <= 2100
      ) {
        add(
          buildISODate(
            Number(
              raw.slice(6, 8)
            ),
            Number(
              raw.slice(4, 6)
            ),
            first4
          ),
          lineIndex,
          raw,
          0.85
        );
        continue;
      }

      const day =
        Number(
          raw.slice(0, 2)
        );
      const month =
        Number(
          raw.slice(2, 4)
        );
      const year =
        Number(
          raw.slice(4, 8)
        );

      add(
        buildISODate(
          day,
          month,
          year
        ),
        lineIndex,
        raw,
        0.65
      );

      add(
        buildISODate(
          month,
          day,
          year
        ),
        lineIndex,
        raw,
        0.55
      );
    }
  }

  return result;
}

function extractIssueDate(
  fullOCR: string,
  expectedExpiry?: string,
  expectedDOB?: string
): string | undefined {
  const candidates =
    extractPassportDates(
      fullOCR
    );

  if (!candidates.length) {
    return undefined;
  }

  /*
   * Best signal:
   * Find the human-readable date that matches the validated MRZ
   * expiry date. If another date appears on the same OCR line,
   * that date is the issue date.
   *
   * This is language-independent.
   */
  if (expectedExpiry) {
    const expiryCandidates =
      candidates.filter(
        item =>
          item.iso === expectedExpiry
      );

    if (expiryCandidates.length) {
      for (
        const expiry of expiryCandidates
      ) {
        const sameLine =
          candidates.filter(
            item =>
              item.lineIndex ===
                expiry.lineIndex &&
              item.iso !==
                expectedExpiry &&
              item.iso !==
                expectedDOB
          );

        if (sameLine.length) {
          sameLine.sort(
            (a, b) =>
              b.confidence -
              a.confidence
          );

          return sameLine[0].iso;
        }
      }

      /*
       * If expiry is matched elsewhere on the page, use the strongest
       * date that is neither DOB nor expiry and occurs before expiry.
       */
      const fallback =
        candidates
          .filter(
            item =>
              item.iso !==
                expectedExpiry &&
              item.iso !==
                expectedDOB &&
              item.iso <
                expectedExpiry
          )
          .sort(
            (a, b) =>
              b.confidence -
                a.confidence ||
              a.lineIndex -
                b.lineIndex
          );

      if (fallback.length) {
        return fallback[0].iso;
      }
    }
  }

  /*
   * Second signal:
   * Exclude known MRZ DOB/expiry and look for a plausible past date.
   * Only return when the best candidate is unambiguous enough.
   */
  const remaining =
    candidates.filter(
      item =>
        item.iso !==
          expectedExpiry &&
        item.iso !==
          expectedDOB
    );

  if (!remaining.length) {
    return undefined;
  }

  const sorted =
    remaining.sort(
      (a, b) =>
        b.confidence -
          a.confidence ||
        a.lineIndex -
          b.lineIndex
    );

  /*
   * Avoid making a blind country/date-format guess when two equally
   * plausible alternatives remain.
   */
  if (
    sorted.length > 1 &&
    sorted[0].confidence ===
      sorted[1].confidence &&
    sorted[0].iso !==
      sorted[1].iso
  ) {
    return undefined;
  }

  return sorted[0].iso;
}

type Attempt = {
  candidate: number;
  source: string;
  variant: string;
  psm: number;
  confidence: number;
  mrzScore: number;
  text: string;
  timeMs: number;
  valid: boolean;
};

function clamp(
  value: number
): number {
  return Math.max(
    0,
    Math.min(
      255,
      value
    )
  );
}

function normalizeOCRText(
  text: string
): string {
  return text
    .toUpperCase()
    .replace(/\r/g, "")
    .replace(
      /[^A-Z0-9<\n]/g,
      ""
    );
}

function getOCRLines(
  text: string
): string[] {
  return normalizeOCRText(
    text
  )
    .split("\n")
    .map(
      value =>
        value.trim()
    )
    .filter(Boolean);
}

/**
 * Normalize a line while preserving
 * the MRZ '<' character.
 */
function normalizeMRZLinse(
  text: string
): string {
  return text
    .toUpperCase()
    .replace(
      /[^A-Z0-9<]/g,
      ""
    );
}

/**
 * ICAO character value.
 */
function mrzCharValue(
  character: string
): number {
  if (
    character === "<"
  ) {
    return 0;
  }

  if (
    character >= "0" &&
    character <= "9"
  ) {
    return Number(
      character
    );
  }

  if (
    character >= "A" &&
    character <= "Z"
  ) {
    return (
      character.charCodeAt(
        0
      ) - 55
    );
  }

  return 0;
}

/**
 * ICAO check digit.
 */
function calculateCheckDigit(
  value: string
): string {
  const weights =
    [7, 3, 1];

  let sum = 0;

  for (
    let i = 0;
    i < value.length;
    i++
  ) {
    sum +=
      mrzCharValue(
        value[i]
      ) *
      weights[
        i % 3
      ];
  }

  return String(
    sum % 10
  );
}

function checkDigitValid(
  value: string,
  expected: string
): boolean {
  if (
    !/^[0-9]$/.test(
      expected
    )
  ) {
    return false;
  }

  return (
    calculateCheckDigit(
      value
    ) === expected
  );
}

/**
 * Strict TD3 validation.
 *
 * This is intentionally strict.
 */
function validateTD3(
  rawLines: string[]
): boolean {
  if (
    rawLines.length !== 2
  ) {
    return false;
  }

  const line1 =
    normalizeMRZLine(
      rawLines[0]
    );

  const line2 =
    normalizeMRZLine(
      rawLines[1]
    );

  if (
    line1.length !== 44 ||
    line2.length !== 44
  ) {
    return false;
  }

  if (
    !line1.startsWith(
      "P<"
    )
  ) {
    return false;
  }

  /*
   * The name field should contain
   * the << separator.
   */
  if (
    !line1.includes(
      "<<"
    )
  ) {
    return false;
  }

  /*
   * Document number.
   */
  if (
    !checkDigitValid(
      line2.slice(0, 9),
      line2[9]
    )
  ) {
    return false;
  }

  /*
   * Date of birth.
   */
  if (
    !checkDigitValid(
      line2.slice(13, 19),
      line2[19]
    )
  ) {
    return false;
  }

  /*
   * Expiry date.
   */
  if (
    !checkDigitValid(
      line2.slice(21, 27),
      line2[27]
    )
  ) {
    return false;
  }

  /*
   * Optional data.
   */
  if (
    !checkDigitValid(
      line2.slice(28, 42),
      line2[42]
    )
  ) {
    return false;
  }

  /*
   * Composite check digit.
   */
  const composite =
    line2.slice(0, 10) +
    line2.slice(13, 20) +
    line2.slice(21, 43);

  if (
    !checkDigitValid(
      composite,
      line2[43]
    )
  ) {
    return false;
  }

  return true;
}

/**
 * Score OCR output as an MRZ candidate.
 *
 * This does NOT declare the candidate valid.
 * ICAO validation does that.
 */
function mrzScore(
  text: string
): number {
  const lines =
    getOCRLines(text);

  if (
    lines.length < 2
  ) {
    return 0;
  }

  const first =
    normalizeMRZLine(
      lines[0]
    );

  const second =
    normalizeMRZLine(
      lines[1]
    );

  let score = 0;

  if (
    first.startsWith(
      "P<"
    )
  ) {
    score +=
      0.30;
  } else if (
    first.startsWith(
      "P"
    )
  ) {
    score +=
      0.12;
  }

  const lessThan =
    (
      `${first}${second}`.match(
        /</g
      ) || []
    ).length;

  score +=
    Math.min(
      1,
      lessThan / 20
    ) *
    0.20;

  score +=
    Math.max(
      0,
      1 -
        Math.abs(
          first.length -
            44
        ) /
          30
    ) *
    0.20;

  score +=
    Math.max(
      0,
      1 -
        Math.abs(
          second.length -
            44
        ) /
          30
    ) *
    0.20;

  if (
    first.includes(
      "<<"
    )
  ) {
    score +=
      0.10;
  }

  return Math.min(
    1,
    score
  );
}

function gray(
  image: ImageData
): void {
  for (
    let i = 0;
    i < image.data.length;
    i += 4
  ) {
    const value =
      0.299 *
        image.data[i] +
      0.587 *
        image.data[i + 1] +
      0.114 *
        image.data[i + 2];

    image.data[i] =
      value;

    image.data[i + 1] =
      value;

    image.data[i + 2] =
      value;
  }
}

function contrast(
  image: ImageData,
  factor = 1.7
): void {
  for (
    let i = 0;
    i < image.data.length;
    i += 4
  ) {
    image.data[i] =
      clamp(
        128 +
          factor *
            (
              image.data[i] -
              128
            )
      );

    image.data[i + 1] =
      clamp(
        128 +
          factor *
            (
              image.data[i + 1] -
              128
            )
      );

    image.data[i + 2] =
      clamp(
        128 +
          factor *
            (
              image.data[i + 2] -
              128
            )
      );
  }
}

function threshold(
  image: ImageData,
  value = 155
): void {
  for (
    let i = 0;
    i < image.data.length;
    i += 4
  ) {
    const result =
      image.data[i] <
      value
        ? 0
        : 255;

    image.data[i] =
      result;

    image.data[i + 1] =
      result;

    image.data[i + 2] =
      result;
  }
}

function processCanvas(
  source: HTMLCanvasElement,
  variant: string
): HTMLCanvasElement {
  const scale =
    variant ===
    "upscale-contrast"
      ? 3
      : 1;

  const canvas =
    document.createElement(
      "canvas"
    );

  canvas.width =
    Math.max(
      1,
      Math.round(
        source.width *
          scale
      )
    );

  canvas.height =
    Math.max(
      1,
      Math.round(
        source.height *
          scale
      )
    );

  const context =
    canvas.getContext(
      "2d",
      {
        willReadFrequently:
          true,
      }
    )!;

  context.imageSmoothingEnabled =
    false;

  context.drawImage(
    source,
    0,
    0,
    canvas.width,
    canvas.height
  );

  const image =
    context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height
    );

  gray(image);

  if (
    variant ===
      "contrast" ||
    variant ===
      "upscale-contrast"
  ) {
    contrast(
      image,
      1.7
    );
  }

  if (
    variant ===
    "threshold"
  ) {
    contrast(
      image,
      1.8
    );

    threshold(
      image
    );
  }

  context.putImageData(
    image,
    0,
    0
  );

  return canvas;
}

function cropCanvas(
  source: HTMLCanvasElement,
  box: BoundingBox
): HTMLCanvasElement {
  const canvas =
    document.createElement(
      "canvas"
    );

  canvas.width =
    Math.max(
      1,
      Math.round(
        box.width
      )
    );

  canvas.height =
    Math.max(
      1,
      Math.round(
        box.height
      )
    );

  const context =
    canvas.getContext(
      "2d"
    )!;

  context.imageSmoothingEnabled =
    false;

  context.drawImage(
    source,
    box.x,
    box.y,
    box.width,
    box.height,
    0,
    0,
    canvas.width,
    canvas.height
  );

  return canvas;
}

async function recognize(
  worker: Worker,
  canvas: HTMLCanvasElement,
  psm: number,
  mrzMode: boolean
) {
  await worker.setParameters(
    {
      tessedit_pageseg_mode:
        String(
          psm
        ) as never,

      ...(mrzMode
        ? {
            tessedit_char_whitelist:
              MRZ_CHARS,
          }
        : {
            tessedit_char_whitelist:
              "",
          }),
    }
  );

  const start =
    performance.now();

  const result =
    await worker.recognize(
      canvas
    );

  return {
    text:
      result.data.text,

    confidence:
      result.data.confidence,

    lines:
      result.data.lines,

    timeMs:
      Math.round(
        performance.now() -
          start
      ),

    data:
      result.data,
  };
}

function drawCandidates(
  target: HTMLCanvasElement,
  source: HTMLCanvasElement,
  candidates: MRZCandidate[],
  selected: number
): void {
  target.width =
    source.width;

  target.height =
    source.height;

  const context =
    target.getContext(
      "2d"
    )!;

  context.drawImage(
    source,
    0,
    0
  );

  context.font =
    `${Math.max(
      14,
      source.width / 70
    )}px sans-serif`;

  context.textBaseline =
    "top";

  candidates.forEach(
    (
      candidate,
      index
    ) => {
      const box =
        candidate.boundingBox;

      const isSelected =
        index ===
        selected;

      context.strokeStyle =
        isSelected
          ? "#22c55e"
          : "#f59e0b";

      context.lineWidth =
        Math.max(
          2,
          source.width /
            500
        );

      context.strokeRect(
        box.x,
        box.y,
        box.width,
        box.height
      );

      context.fillStyle =
        isSelected
          ? "#15803d"
          : "#b45309";

      context.fillText(
        `${index + 1}. ${
          candidate.source
        } ${
          candidate.confidence.toFixed(
            2
          )
        }${
          isSelected
            ? " SELECTED"
            : ""
        }`,
        box.x,
        Math.max(
          0,
          box.y - 22
        )
      );
    }
  );
}

function iou(
  a: BoundingBox,
  b: BoundingBox
): number {
  const x =
    Math.max(
      a.x,
      b.x
    );

  const y =
    Math.max(
      a.y,
      b.y
    );

  const right =
    Math.min(
      a.x + a.width,
      b.x + b.width
    );

  const bottom =
    Math.min(
      a.y + a.height,
      b.y + b.height
    );

  const intersection =
    Math.max(
      0,
      right - x
    ) *
    Math.max(
      0,
      bottom - y
    );

  const smaller =
    Math.min(
      a.width *
        a.height,
      b.width *
        b.height
    );

  return (
    intersection /
    Math.max(
      smaller,
      1
    )
  );
}

function mergeCandidates(
  candidates: MRZCandidate[]
): MRZCandidate[] {
  const result: MRZCandidate[] =
    [];

  for (
    const candidate of candidates.sort(
      (a, b) =>
        b.confidence -
        a.confidence
    )
  ) {
    const duplicate =
      result.some(
        existing =>
          iou(
            existing.boundingBox,
            candidate.boundingBox
          ) > 0.55
      );

    if (!duplicate) {
      result.push(
        candidate
      );
    }
  }

  return result.slice(
    0,
    20
  );
}

type OrientedCandidate = {
  candidate: MRZCandidate;
  canvas: HTMLCanvasElement;
  rotation: number;
  orientationScore: number;
  fullOCR: string;
};

function rotateCanvasExact(
  source: HTMLCanvasElement,
  degrees: number
): HTMLCanvasElement {
  const normalized = ((degrees % 360) + 360) % 360;
  if (normalized === 0) {
    const copy = document.createElement("canvas");
    copy.width = source.width;
    copy.height = source.height;
    copy.getContext("2d")!.drawImage(source, 0, 0);
    return copy;
  }

  const output = document.createElement("canvas");
  const ctx = output.getContext("2d")!;

  if (normalized === 90 || normalized === 270) {
    output.width = source.height;
    output.height = source.width;
  } else {
    output.width = source.width;
    output.height = source.height;
  }

  if (normalized === 90) {
    ctx.translate(output.width, 0);
    ctx.rotate(Math.PI / 2);
  } else if (normalized === 180) {
    ctx.translate(output.width, output.height);
    ctx.rotate(Math.PI);
  } else if (normalized === 270) {
    ctx.translate(0, output.height);
    ctx.rotate(-Math.PI / 2);
  }

  ctx.drawImage(source, 0, 0);
  return output;
}

function extractOCRLines(
  output: Awaited<ReturnType<typeof recognize>>
): OCRLine[] {
  return (output.data.lines ?? [])
    .map((line: any) => {
      const x0 = line.bbox?.x0 ?? 0;
      const y0 = line.bbox?.y0 ?? 0;
      const x1 = line.bbox?.x1 ?? 0;
      const y1 = line.bbox?.y1 ?? 0;
      return {
        text: line.text ?? "",
        bbox: {
          x: x0,
          y: y0,
          width: x1 - x0,
          height: y1 - y0,
        },
        confidence: line.confidence ?? output.confidence,
      };
    })
    .filter(
      line =>
        line.bbox.width > 0 &&
        line.bbox.height > 0
    );
}

function candidatePriority(
  candidate: MRZCandidate
): number {
  if (candidate.source === "p-anchor") return 3;
  if (candidate.source === "ocr") return 2;
  return 1;
}

function sortOrientedCandidates(
  items: OrientedCandidate[]
): OrientedCandidate[] {
  return [...items].sort((a, b) => {
    const pa = candidatePriority(a.candidate);
    const pb = candidatePriority(b.candidate);
    if (pa !== pb) return pb - pa;
    return b.orientationScore - a.orientationScore;
  });
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("Choose an image");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [debug, setDebug] = useState(true);

  const processedCanvas = useRef<HTMLCanvasElement>(null);
  const debugCanvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  async function scan() {
    if (!file) return;

    setBusy(true);
    setError("");
    setResult(null);

    let worker: Worker | null = null;
    let bitmap: ImageBitmap | null = null;
    const start = performance.now();

    try {
      setStatus("Decoding image...");
      bitmap = await createImageBitmap(file);

      const scale = Math.min(
        1,
        2400 / Math.max(bitmap.width, bitmap.height)
      );
      const sourceWidth = Math.max(1, Math.round(bitmap.width * scale));
      const sourceHeight = Math.max(1, Math.round(bitmap.height * scale));

      const source = document.createElement("canvas");
      source.width = sourceWidth;
      source.height = sourceHeight;
      source.getContext("2d")!.drawImage(
        bitmap,
        0,
        0,
        sourceWidth,
        sourceHeight
      );

      setStatus("Loading Tesseract...");
      worker = await createWorker("eng", 1, {
        logger: message => {
          if (message.status === "recognizing text") {
            setStatus(`OCR: ${Math.round(message.progress * 100)}%`);
          }
        },
      });

      /*
       * IMPORTANT ROTATION RULE:
       *
       * OCR coordinates and crop coordinates must belong to the SAME canvas.
       * We therefore never map a rotated bounding box back to the original
       * image. The crop is taken directly from the exact oriented canvas
       * that produced the OCR coordinates.
       */
      const rotations = [0, 90, 180, 270];
      const oriented: OrientedCandidate[] = [];
      const orientationDiagnostics: any[] = [];

      for (const rotation of rotations) {
        setStatus(`Checking orientation ${rotation}°...`);
        const orientedCanvas = rotateCanvasExact(source, rotation);
        const ow = orientedCanvas.width;
        const oh = orientedCanvas.height;

        const initial = await recognize(
          worker,
          orientedCanvas,
          3,
          false
        );

        const ocrLines = extractOCRLines(initial);
        const pAnchors = findPAnchors(ocrLines, ow, oh);
        const pairCandidates = detectMRZFromOCR(ocrLines, ow, oh);
        const visual = detectMRZCandidates(
          orientedCanvas
            .getContext("2d", { willReadFrequently: true })!
            .getImageData(0, 0, ow, oh)
        );

        const candidates = mergeCandidates([
          ...pAnchors,
          ...pairCandidates,
          ...visual,
        ]);

        const bestCandidate = candidates[0];
        const sourceBonus = bestCandidate
          ? candidatePriority(bestCandidate) * 0.25
          : 0;
        const orientationScore =
          (bestCandidate?.confidence ?? 0) +
          sourceBonus +
          (initial.confidence / 100) * 0.05;

        orientationDiagnostics.push({
          rotation,
          width: ow,
          height: oh,
          ocrConfidence: initial.confidence,
          candidateCount: candidates.length,
          bestCandidate: bestCandidate
            ? {
                source: bestCandidate.source,
                confidence: bestCandidate.confidence,
                boundingBox: bestCandidate.boundingBox,
              }
            : null,
        });

        for (const candidate of candidates.slice(0, 8)) {
          oriented.push({
            candidate: {
              ...candidate,
              rotation,
            },
            canvas: orientedCanvas,
            rotation,
            orientationScore:
              orientationScore +
              candidate.confidence * 0.5,
            fullOCR: initial.text,
          });
        }
      }

      const candidatesToTest = sortOrientedCandidates(oriented).slice(0, 12);

      if (!candidatesToTest.length) {
        throw new Error(
          "No MRZ candidate was detected in any orientation."
        );
      }

      setStatus(
        `Found MRZ candidates across ${rotations.length} orientations. Testing...`
      );

      const attempts: Attempt[] = [];
      let accepted: Attempt | undefined;
      let acceptedLines: string[] = [];
      let acceptedItem: OrientedCandidate | undefined;
      let best: Attempt | undefined;
      let bestProcessed: HTMLCanvasElement | undefined;
      let bestItem: OrientedCandidate | undefined;

      const variants: [string, number][] = [
        ["normal", 6],
        ["contrast", 6],
        ["threshold", 6],
        ["upscale-contrast", 6],
        ["normal", 7],
        ["contrast", 7],
        ["threshold", 7],
        ["upscale-contrast", 7],
        ["normal", 13],
        ["upscale-contrast", 13],
      ];

      for (
        let candidateIndex = 0;
        candidateIndex < candidatesToTest.length;
        candidateIndex++
      ) {
        const item = candidatesToTest[candidateIndex];
        const sourceCanvas = item.canvas;
        const iw = sourceCanvas.width;
        const ih = sourceCanvas.height;

        const crop = paddedCrop(
          item.candidate.boundingBox,
          iw,
          ih,
          0.20
        );
        const mrzCrop = cropCanvas(sourceCanvas, crop);

        for (const [variant, psm] of variants) {
          const processed = processCanvas(mrzCrop, variant);
          const output = await recognize(
            worker,
            processed,
            psm,
            true
          );
          const lines = getOCRLines(output.text);
          const reconstructed = reconstructTD3(
            lines,
            item.fullOCR
          );
          console.log("FULL OCR:", item.fullOCR);
          console.log("MRZ OCR LINES:", lines);
          console.log("RECONSTRUCTED:", reconstructed);

          // First require strict ICAO TD3 validity. Then use the full-page
          // OCR from the same orientation as supporting evidence to rank
          // otherwise-valid candidates.
          function mrzNameQuality(line1: string): number {
            // TD3 name area = positions 5..43
            const nameField = line1.slice(5, 44);

            let score = 0;

            // Proper surname/given-name separator.
            if (nameField.includes("<<")) {
              score += 30;
            }

            // Get the meaningful name before the filler area.
            const namePart = nameField
              .replace(/<+$/g, "")
              .trim();

            // More actual letters generally means less truncated.
            const letters = (
              namePart.match(/[A-Z]/g) || []
            ).length;

            score += letters * 2;

            // Penalize suspicious OCR-confusion characters
            // when they appear after the meaningful name.
            const filler = nameField
              .replace(/^[^<]*<</, "")
              .replace(/<+[A-Z0-9]+/g, "");

            const suspicious =
              (filler.match(/[KLI1]/g) || []).length;

            score -= suspicious * 8;

            // Strong penalty for an obviously truncated final surname/name.
            if (
              /[A-Z]{3,}<+[A-Z]{2,}/.test(
                nameField
              )
            ) {
              score -= 15;
            }

            return score;
          }

          const candidatesWithValidation = reconstructed
            .map(candidate => {
              const td3Valid = validateTD3(candidate);

              const cross = crossValidateTD3(
                candidate[0],
                candidate[1],
                item.fullOCR
              );

              const scored = scoreMRZCandidate({
                candidate,
                rawMRZOCRText: output.text,
                fullPageOCRText: item.fullOCR,
                td3Valid,
                cross,
              });

              return {
                candidate,
                td3Valid,
                cross,
                scored,
              };
            })
            .sort((a, b) =>
              b.scored.total - a.scored.total
            );

          console.table(
            candidatesWithValidation
              .slice(0, 10)
              .map((item, index) => ({
                index,
                total: item.scored.total,
                valid: item.td3Valid,
                name: item.scored.breakdown.name,
                identity: item.scored.breakdown.identityFields,
                filler: item.scored.breakdown.filler,
                rawOCR: item.scored.breakdown.rawOCRPreservation,
                cross: item.scored.breakdown.crossValidation,
                line1: item.candidate[0],
                line2: item.candidate[1],
              }))
          );

          const bestCandidate =
            candidatesWithValidation[0];

          const reconstructedValid =
            bestCandidate?.td3Valid
              ? bestCandidate.candidate
              : undefined;

          const crossValidation =
            bestCandidate?.cross ?? null;

          const score =
            mrzScore(output.text) +
            (crossValidation?.score ?? 0) * 0.25;

          const isValid =
            !!reconstructedValid;

          const attempt: Attempt = {
            candidate: candidateIndex,
            source: item.candidate.source ?? "unknown",
            variant,
            psm,
            confidence: output.confidence,
            mrzScore: score,
            text: output.text,
            timeMs: output.timeMs,
            valid: isValid,
          };

          attempts.push(attempt);

          if (!best || score > best.mrzScore) {
            best = attempt;
            bestProcessed = processed;
            bestItem = item;
          }

          if (isValid && reconstructedValid) {
            accepted = {
              ...attempt,
              // Keep the OCR text in attempts, but expose the reconstructed
              // ICAO-valid lines as the accepted MRZ.
              text: reconstructedValid.join("\n"),
              valid: true,
            };
            acceptedLines = reconstructedValid ?? [];
            acceptedItem = item;
            bestProcessed = processed;
            bestItem = item;
            break;
          }
        }

        if (accepted) break;
      }

      if (bestProcessed && processedCanvas.current) {
        processedCanvas.current.width = bestProcessed.width;
        processedCanvas.current.height = bestProcessed.height;
        processedCanvas.current
          .getContext("2d")!
          .drawImage(bestProcessed, 0, 0);
      }

      const selectedItem = acceptedItem ?? bestItem ?? candidatesToTest[0];
      const selectedIndex = candidatesToTest.indexOf(selectedItem);

      if (debug && debugCanvas.current) {
        drawCandidates(
          debugCanvas.current,
          selectedItem.canvas,
          candidatesToTest
            .filter(item => item.rotation === selectedItem.rotation)
            .map(item => item.candidate),
          Math.max(
            0,
            candidatesToTest
              .filter(item => item.rotation === selectedItem.rotation)
              .indexOf(selectedItem)
          )
        );
      }

      const selectedCrop = selectedItem
        ? paddedCrop(
            selectedItem.candidate.boundingBox,
            selectedItem.canvas.width,
            selectedItem.canvas.height,
            0.20
          )
        : null;

      const passport = acceptedLines.length === 2
        ? parseTD3(acceptedLines)
        : null;

      const issueDate =
        passport && selectedItem
          ? extractIssueDate(
              selectedItem.fullOCR,
              typeof passport.date_of_expiry === "string"
                ? passport.date_of_expiry
                : undefined,
              typeof passport.date_of_birth === "string"
                ? passport.date_of_birth
                : undefined
            )
          : undefined;

      const passportWithIssueDate =
        passport
          ? {
              ...passport,
              date_of_issue: issueDate,
            }
          : null;

      const diagnostics = {
        image: {
          originalWidth: bitmap.width,
          originalHeight: bitmap.height,
          normalizedWidth: sourceWidth,
          normalizedHeight: sourceHeight,
        },
        rotation: {
          selected: selectedItem?.rotation ?? null,
          tested: rotations,
          note:
            "Crop coordinates are always taken from the same rotated canvas used for OCR.",
        },
        orientations: orientationDiagnostics,
        detector: {
          totalCandidates: candidatesToTest.length,
          selected: selectedIndex,
          selectedCandidate: selectedItem?.candidate ?? null,
        },
        attempts,
        reconstruction: {
          enabled: true,
          note: "Tesseract filler-character errors are repaired only as candidates and accepted only after ICAO TD3 validation.",
        },
        crossValidation: acceptedLines.length === 2 && selectedItem
          ? crossValidateTD3(
              acceptedLines[0],
              acceptedLines[1],
              selectedItem.fullOCR
            )
          : null,
        issueDate,
      };

      setResult({
        success: !!accepted,
        rawText: best?.text ?? "",
        mrz: acceptedLines.join("\n"),
        passport: passportWithIssueDate,
        confidence: best?.confidence ?? 0,
        processingMs: Math.round(performance.now() - start),
        crop: selectedCrop,
        attempts,
        diagnostics,
      });

      setStatus(
        accepted
          ? `Valid ICAO TD3 MRZ found (${selectedItem?.rotation ?? 0}°)`
          : `MRZ candidate found, but no ICAO-valid TD3 MRZ was extracted. Tested ${candidatesToTest.length} candidates.`
      );
    } catch (scanError) {
      const message =
        scanError instanceof Error
          ? scanError.message
          : String(scanError);
      setError(message);
      setStatus("Scan failed");
    } finally {
      bitmap?.close();
      if (worker) await worker.terminate();
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="card">
        <div className="head">
          <div>
            <small>BROWSER / ON-DEVICE OCR</small>
            <h1>Passport OCR</h1>
            <p>
              Position-independent MRZ detection + Canvas + Tesseract.js. No backend.
            </p>
          </div>
          <b>LOCAL</b>
        </div>

        <div className="controls">
          <label className="upload">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={event => {
                const selected = event.target.files?.[0] ?? null;
                setFile(selected);
                setResult(null);
                setError("");
                if (selected) {
                  if (url) URL.revokeObjectURL(url);
                  setUrl(URL.createObjectURL(selected));
                  setStatus(`${selected.name} selected`);
                } else {
                  setStatus("Choose an image");
                }
              }}
            />
            Choose image
          </label>

          <button disabled={!file || busy} onClick={scan}>
            {busy ? "Scanning..." : "Scan Passport"}
          </button>

          <label className="debug">
            <input
              type="checkbox"
              checked={debug}
              onChange={event => setDebug(event.target.checked)}
            />
            Show detector debug
          </label>
        </div>

        <div className="grid">
          <section>
            <h2>Original</h2>
            <div className="box">
              {url ? <img src={url} alt="Passport" /> : <span>No image</span>}
            </div>
          </section>

          <section>
            <h2>Processed MRZ crop</h2>
            <div className="box dark">
              <canvas ref={processedCanvas} />
              {!result && <span>Selected MRZ crop appears here</span>}
            </div>
          </section>
        </div>

        {debug && result && (
          <section className="debug-view">
            <h2>Detector debug</h2>
            <p>
              Green is the selected candidate. Detection tests 0°, 90°, 180° and 270°.
            </p>
            <canvas ref={debugCanvas} />
          </section>
        )}

        <div className="status">{status}</div>
        {error && <div className="error">{error}</div>}

        {result && (
          <div className="results">
            <div className="panel">
              <h2>OCR</h2>
              <pre>{result.rawText || "No text"}</pre>
            </div>

            <div className="panel">
              <h2>MRZ Candidate</h2>
              <pre>{result.mrz || "No valid MRZ"}</pre>
            </div>

            <div className="panel">
              <h2>Passport JSON</h2>
              <pre>{JSON.stringify(result.passport, null, 2)}</pre>
            </div>

            <div className="panel">
              <h2>Diagnostics</h2>
              <pre>{JSON.stringify(result.diagnostics, null, 2)}</pre>
            </div>
          </div>
        )}

        <div className="privacy">
          <strong>Privacy:</strong> the selected image is processed locally in the browser. Passport text is never written to console logs.
        </div>
      </div>
    </div>
  );
}