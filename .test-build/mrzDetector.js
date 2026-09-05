const clamp = (value) => Math.max(0, Math.min(1, value));
export function normalizeMRZText(text) {
    return text
        .toUpperCase()
        .replace(/\r/g, "")
        .replace(/[ \t]+/g, "")
        .replace(/[^A-Z0-9<\n]/g, "");
}
function normalizeSingleLine(text) {
    return normalizeMRZText(text)
        .replace(/\n/g, "");
}
function mrzCharScore(text) {
    const value = normalizeSingleLine(text);
    if (!value) {
        return 0;
    }
    let valid = 0;
    for (const char of value) {
        if ((char >= "A" &&
            char <= "Z") ||
            (char >= "0" &&
                char <= "9") ||
            char === "<") {
            valid++;
        }
    }
    return (valid /
        Math.max(value.length, 1));
}
function separatorScore(text) {
    const value = normalizeSingleLine(text);
    if (value.includes("<<")) {
        return 1;
    }
    if (value.includes("<")) {
        return 0.4;
    }
    return 0;
}
function pLessThanScore(text) {
    const value = normalizeSingleLine(text);
    if (value.startsWith("P<")) {
        return 1;
    }
    if (/^P[A-Z]{2,3}/.test(value)) {
        return 0.65;
    }
    if (value.startsWith("P")) {
        return 0.3;
    }
    return 0;
}
function closeness(value, target, spread) {
    return clamp(1 -
        Math.abs(value - target) /
            spread);
}
/**
 * Find OCR lines which can act as
 * the MRZ P< anchor.
 *
 * Examples accepted:
 *
 * P<IND...
 * P<USA...
 * P<FRA...
 * PIND...
 *
 * We do not treat this as validation.
 * It is only a locator.
 */
export function findPAnchors(lines, imageWidth, imageHeight) {
    const candidates = [];
    for (const line of lines) {
        const text = normalizeSingleLine(line.text);
        if (!text) {
            continue;
        }
        /*
         * Exact P<.
         */
        const exactP = text.startsWith("P<");
        /*
         * OCR sometimes loses <.
         *
         * Example:
         *
         * PIND...
         * P IND...
         */
        const possibleP = /^P[A-Z]{2,3}/.test(text);
        if (!exactP &&
            !possibleP) {
            continue;
        }
        /*
         * Avoid ordinary passport text
         * beginning with the letter P.
         */
        if (!exactP &&
            text.length < 4) {
            continue;
        }
        const lessThanCount = (text.match(/</g) || []).length;
        const longLine = text.length >= 12;
        /*
         * A real MRZ line normally contains
         * many '<' characters.
         *
         * However, OCR can lose them.
         */
        const structuralScore = exactP
            ? 1
            : possibleP
                ? 0.65
                : 0;
        const separatorScoreValue = Math.min(1, lessThanCount / 8);
        const lengthScore = closeness(text.length, 44, 30);
        const widthScore = clamp(line.bbox.width /
            Math.max(imageWidth * 0.35, 1));
        const lowerPositionScore = clamp(line.bbox.y /
            Math.max(imageHeight, 1));
        const confidence = structuralScore *
            0.45 +
            separatorScoreValue *
                0.20 +
            lengthScore *
                0.15 +
            widthScore *
                0.10 +
            lowerPositionScore *
                0.10;
        candidates.push({
            format: "TD3",
            /*
             * This box is intentionally larger
             * than the OCR line itself.
             *
             * The second MRZ line is normally
             * immediately below it.
             */
            boundingBox: {
                x: Math.max(0, Math.floor(line.bbox.x -
                    line.bbox.width *
                        0.08)),
                y: Math.max(0, Math.floor(line.bbox.y -
                    line.bbox.height *
                        0.75)),
                width: Math.min(imageWidth, Math.ceil(imageWidth -
                    Math.max(0, line.bbox.x -
                        line.bbox.width *
                            0.08))),
                height: Math.min(imageHeight -
                    Math.max(0, Math.floor(line.bbox.y -
                        line.bbox.height *
                            0.75)), Math.ceil(line.bbox.height *
                    4.8)),
            },
            confidence,
            source: "p-anchor",
            text: line.text,
            features: {
                lineCountScore: 0.5,
                lineLengthScore: lengthScore,
                horizontalDensityScore: separatorScoreValue,
                characterCompatibilityScore: mrzCharScore(text),
                lineSpacingScore: 0,
                alignmentScore: 0,
                pLessThanScore: structuralScore,
                nameSeparatorScore: separatorScore(text),
                lowerPositionScore: lowerPositionScore,
            },
        });
    }
    return candidates
        .sort((a, b) => b.confidence -
        a.confidence)
        .slice(0, 10);
}
/**
 * Score a pair of OCR lines as
 * a possible TD3 MRZ.
 */
export function scoreOCRPair(first, second, imageWidth, imageHeight) {
    let topLine = first;
    let bottomLine = second;
    if (topLine.bbox.y >
        bottomLine.bbox.y) {
        [topLine, bottomLine] = [
            bottomLine,
            topLine,
        ];
    }
    const left = Math.min(topLine.bbox.x, bottomLine.bbox.x);
    const right = Math.max(topLine.bbox.x +
        topLine.bbox.width, bottomLine.bbox.x +
        bottomLine.bbox.width);
    const top = Math.min(topLine.bbox.y, bottomLine.bbox.y);
    const bottom = Math.max(topLine.bbox.y +
        topLine.bbox.height, bottomLine.bbox.y +
        bottomLine.bbox.height);
    const width = right - left;
    const height = bottom - top;
    const meanHeight = (topLine.bbox.height +
        bottomLine.bbox.height) / 2;
    const gap = bottomLine.bbox.y -
        (topLine.bbox.y +
            topLine.bbox.height);
    const lineSpacingScore = closeness(gap /
        Math.max(meanHeight, 1), 0.7, 2.5);
    const alignmentScore = clamp(1 -
        Math.abs(topLine.bbox.x -
            bottomLine.bbox.x) /
            Math.max(width, 1));
    const firstText = normalizeSingleLine(topLine.text);
    const secondText = normalizeSingleLine(bottomLine.text);
    const firstLengthScore = closeness(firstText.length, 44, 30);
    const secondLengthScore = closeness(secondText.length, 44, 30);
    const lineLengthScore = (firstLengthScore +
        secondLengthScore) / 2;
    const characterCompatibilityScore = (mrzCharScore(firstText) +
        mrzCharScore(secondText)) / 2;
    const pScore = pLessThanScore(firstText);
    const nameScore = Math.max(separatorScore(firstText), separatorScore(secondText));
    const aspectRatio = width /
        Math.max(height, 1);
    const widthScore = closeness(aspectRatio, 12, 10);
    const lowerPositionScore = clamp(top /
        Math.max(imageHeight, 1));
    const ocrConfidence = ((topLine.confidence ??
        0) +
        (bottomLine.confidence ??
            0)) /
        2 /
        100;
    /*
     * IMPORTANT:
     *
     * P< and << have much stronger
     * weight than ordinary text geometry.
     */
    const confidence = lineLengthScore *
        0.15 +
        characterCompatibilityScore *
            0.15 +
        lineSpacingScore *
            0.10 +
        alignmentScore *
            0.05 +
        widthScore *
            0.10 +
        pScore *
            0.20 +
        nameScore *
            0.15 +
        lowerPositionScore *
            0.05 +
        ocrConfidence *
            0.05;
    return {
        format: "TD3",
        boundingBox: {
            x: left,
            y: top,
            width,
            height,
        },
        confidence,
        source: "ocr",
        text: `${topLine.text}\n` +
            `${bottomLine.text}`,
        features: {
            lineCountScore: 1,
            lineLengthScore,
            horizontalDensityScore: characterCompatibilityScore,
            characterCompatibilityScore,
            lineSpacingScore,
            alignmentScore,
            pLessThanScore: pScore,
            nameSeparatorScore: nameScore,
            lowerPositionScore,
        },
    };
}
/**
 * Find two nearby OCR lines.
 *
 * This remains as a secondary OCR
 * fallback when P< is not detected.
 */
export function detectMRZFromOCR(lines, imageWidth, imageHeight) {
    const cleaned = lines
        .filter(line => line.text
        .trim()
        .length >= 5)
        .filter(line => line.bbox.width >=
        imageWidth * 0.10)
        .sort((a, b) => a.bbox.y -
        b.bbox.y);
    const candidates = [];
    for (let i = 0; i < cleaned.length; i++) {
        for (let j = i + 1; j < cleaned.length; j++) {
            const first = cleaned[i];
            const second = cleaned[j];
            const firstBottom = first.bbox.y +
                first.bbox.height;
            const gap = second.bbox.y -
                firstBottom;
            const meanHeight = (first.bbox.height +
                second.bbox.height) / 2;
            if (gap >
                Math.max(meanHeight * 4, 40)) {
                break;
            }
            if (gap <
                -meanHeight * 0.2) {
                continue;
            }
            const candidate = scoreOCRPair(first, second, imageWidth, imageHeight);
            const combinedText = `${first.text} ${second.text}`;
            const lessThanCount = (combinedText.match(/</g) || []).length;
            const normalizedLength = normalizeSingleLine(combinedText).length;
            /*
             * Reject obvious ordinary text.
             */
            if (lessThanCount < 2 &&
                normalizedLength < 55) {
                continue;
            }
            const width1 = first.bbox.width;
            const width2 = second.bbox.width;
            const widthSimilarity = Math.min(width1, width2) /
                Math.max(width1, width2);
            if (widthSimilarity <
                0.55) {
                continue;
            }
            candidates.push(candidate);
        }
    }
    return candidates
        .sort((a, b) => b.confidence -
        a.confidence)
        .slice(0, 20);
}
function getBands(image) {
    const { width, height, data, } = image;
    const rowScore = new Array(height).fill(0);
    for (let y = 0; y < height; y++) {
        let dark = 0;
        for (let x = 0; x < width; x += 2) {
            const index = (y * width + x) *
                4;
            const value = 0.299 * data[index] +
                0.587 *
                    data[index + 1] +
                0.114 *
                    data[index + 2];
            if (value < 145) {
                dark++;
            }
        }
        rowScore[y] =
            dark /
                Math.ceil(width / 2);
    }
    const maxScore = Math.max(...rowScore);
    const threshold = Math.max(0.035, maxScore * 0.18);
    const active = rowScore.map(value => value >
        threshold);
    const bands = [];
    let y = 0;
    while (y < height) {
        if (!active[y]) {
            y++;
            continue;
        }
        const start = y;
        while (y < height &&
            active[y]) {
            y++;
        }
        const end = y;
        const bandHeight = end - start;
        if (bandHeight < 2 ||
            bandHeight >
                height * 0.08) {
            continue;
        }
        let minX = width;
        let maxX = 0;
        let darkPixels = 0;
        let totalPixels = 0;
        for (let yy = start; yy < end; yy++) {
            for (let x = 0; x < width; x += 2) {
                const index = (yy * width + x) *
                    4;
                const value = 0.299 * data[index] +
                    0.587 *
                        data[index + 1] +
                    0.114 *
                        data[index + 2];
                if (value < 145) {
                    darkPixels++;
                    minX =
                        Math.min(minX, x);
                    maxX =
                        Math.max(maxX, x);
                }
                totalPixels++;
            }
        }
        if (maxX <= minX ||
            maxX - minX <
                width * 0.20) {
            continue;
        }
        bands.push({
            x: minX,
            y: start,
            width: maxX - minX,
            height: bandHeight,
            density: darkPixels /
                Math.max(totalPixels, 1),
        });
    }
    return bands;
}
export function detectMRZCandidates(image) {
    const bands = getBands(image);
    const candidates = [];
    for (let i = 0; i <
        bands.length - 1; i++) {
        for (let j = i + 1; j < bands.length; j++) {
            const first = bands[i];
            const second = bands[j];
            const gap = second.y -
                (first.y +
                    first.height);
            if (gap < 0) {
                continue;
            }
            if (gap >
                Math.max(first.height, second.height) * 4) {
                break;
            }
            const left = Math.min(first.x, second.x);
            const right = Math.max(first.x +
                first.width, second.x +
                second.width);
            const top = Math.min(first.y, second.y);
            const bottom = Math.max(first.y +
                first.height, second.y +
                second.height);
            const boxWidth = right - left;
            const boxHeight = bottom - top;
            if (boxWidth <
                image.width * 0.20) {
                continue;
            }
            const widthScore = closeness(boxWidth /
                Math.max(boxHeight, 1), 12, 10);
            const spacingScore = closeness(gap /
                Math.max((first.height +
                    second.height) / 2, 1), 0.7, 2.5);
            const alignmentScore = clamp(1 -
                Math.abs(first.x -
                    second.x) /
                    Math.max(boxWidth, 1));
            const density = (first.density +
                second.density) / 2;
            const densityScore = clamp(density * 4);
            const confidence = widthScore * 0.35 +
                spacingScore * 0.25 +
                alignmentScore * 0.20 +
                densityScore * 0.20;
            candidates.push({
                format: "TD3",
                boundingBox: {
                    x: left,
                    y: top,
                    width: boxWidth,
                    height: boxHeight,
                },
                confidence,
                source: "visual",
                features: {
                    lineCountScore: 1,
                    lineLengthScore: widthScore,
                    horizontalDensityScore: densityScore,
                    characterCompatibilityScore: 0,
                    lineSpacingScore: spacingScore,
                    alignmentScore,
                    pLessThanScore: 0,
                    nameSeparatorScore: 0,
                    lowerPositionScore: top /
                        Math.max(image.height, 1),
                },
            });
        }
    }
    return candidates
        .sort((a, b) => b.confidence -
        a.confidence)
        .slice(0, 20);
}
export function paddedCrop(box, imageWidth, imageHeight, padding = 0.12) {
    const px = Math.max(8, box.width *
        padding);
    const py = Math.max(8, box.height *
        padding);
    const x = Math.max(0, Math.floor(box.x - px));
    const y = Math.max(0, Math.floor(box.y - py));
    return {
        x,
        y,
        width: Math.min(imageWidth - x, Math.ceil(box.width +
            px * 2)),
        height: Math.min(imageHeight - y, Math.ceil(box.height +
            py * 2)),
    };
}
