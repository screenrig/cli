/**
 * CLI-private conservative advance table for bundled `sans` (Inter) at
 * weights 400 and 700. Values are thousandths of an em and overestimate the
 * real glyph so author-time fit undersizes rather than clips. Players never
 * read this table; they paint the ordinary `font_size` the expander emits.
 *
 * Inter line-box: unitsPerEm 2048, typoAscender 1984, typoDescender -494.
 * Natural height is font_size * 2478 / 2048. Half-leading below that clips
 * descenders under no-overflow.
 */

export const SANS_UNITS_PER_EM = 2048;
export const SANS_TYPO_ASCENDER = 1984;
export const SANS_TYPO_DESCENDER = 494;
export const SANS_LINE_BOX = SANS_TYPO_ASCENDER + SANS_TYPO_DESCENDER;

/** Unknown glyphs take a wide 1.1 em so a missing entry cannot under-measure. */
const UNKNOWN_ADVANCE = 1100;

const REGULAR_ASCII = [
  310, 317, 513, 697, 706, 1081, 709, 330, 402, 402, 552, 728, 317, 506, 317, 397,
  694, 448, 671, 680, 711, 653, 683, 623, 681, 683, 317, 332, 728, 728, 728, 563,
  1063, 759, 720, 804, 794, 662, 650, 821, 818, 296, 628, 740, 622, 994, 829, 842,
  703, 842, 708, 706, 711, 819, 759, 1084, 751, 747, 692, 402, 397, 402, 519, 502,
  356, 618, 674, 629, 674, 642, 408, 675, 651, 267, 267, 604, 267, 964, 650, 660,
  674, 674, 415, 581, 360, 651, 619, 901, 601, 619, 608, 469, 366, 469, 728,
] as const;

const BOLD_ASCII = [
  261, 372, 607, 714, 721, 1118, 740, 373, 415, 415, 615, 747, 368, 515, 368, 428,
  742, 475, 693, 711, 744, 685, 715, 640, 716, 715, 368, 378, 747, 747, 747, 616,
  1118, 822, 728, 814, 795, 669, 646, 826, 822, 309, 643, 792, 622, 1025, 839, 848,
  713, 855, 723, 721, 735, 806, 822, 1142, 813, 805, 731, 415, 428, 415, 536, 524,
  402, 639, 694, 648, 694, 656, 438, 696, 685, 299, 299, 639, 299, 1004, 685, 675,
  694, 694, 448, 617, 403, 685, 660, 936, 639, 663, 631, 516, 409, 516, 747,
] as const;

const REGULAR_EXTRA: Readonly<Record<string, number>> = {
  "\u00a0": 310,
  "\u00b7": 317,
  "\u00e0": 618,
  "\u00e4": 618,
  "\u00e8": 642,
  "\u00e9": 642,
  "\u00f6": 660,
  "\u00fc": 651,
  "\u2013": 550,
  "\u2014": 1100,
  "\u2018": 287,
  "\u2019": 287,
  "\u201c": 485,
  "\u201d": 485,
  "\u2022": 619,
  "\u2026": 951,
};

const BOLD_EXTRA: Readonly<Record<string, number>> = {
  "\u00a0": 261,
  "\u00b7": 368,
  "\u00e0": 639,
  "\u00e4": 639,
  "\u00e8": 656,
  "\u00e9": 656,
  "\u00f6": 675,
  "\u00fc": 685,
  "\u2013": 550,
  "\u2014": 1100,
  "\u2018": 342,
  "\u2019": 342,
  "\u201c": 595,
  "\u201d": 585,
  "\u2022": 522,
  "\u2026": 1103,
};

const REGULAR = buildTable(REGULAR_ASCII, REGULAR_EXTRA);
const BOLD = buildTable(BOLD_ASCII, BOLD_EXTRA);

function buildTable(
  ascii: readonly number[],
  extras: Readonly<Record<string, number>>,
): ReadonlyMap<number, number> {
  const table = new Map<number, number>();
  for (let index = 0; index < ascii.length; index += 1) {
    table.set(32 + index, ascii[index]!);
  }
  for (const [glyph, advance] of Object.entries(extras)) {
    table.set(glyph.codePointAt(0)!, advance);
  }
  return table;
}

export function minSansLineHeight(fontSize: number): number {
  return Math.ceil((fontSize * SANS_LINE_BOX) / SANS_UNITS_PER_EM);
}

export function measureSansLineWidth(
  text: string,
  fontSize: number,
  weight: 400 | 700,
): number {
  const table = weight === 700 ? BOLD : REGULAR;
  let thousandths = 0;
  for (const glyph of text) {
    thousandths += table.get(glyph.codePointAt(0)!) ?? UNKNOWN_ADVANCE;
  }
  return Math.ceil((thousandths * fontSize) / 1000);
}

export function longestSansLineWidth(
  lines: readonly string[],
  fontSize: number,
  weight: 400 | 700,
): number {
  let widest = 0;
  for (const line of lines) {
    const width = measureSansLineWidth(line, fontSize, weight);
    if (width > widest) {
      widest = width;
    }
  }
  return widest;
}
