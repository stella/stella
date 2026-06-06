import type { MeasuredLine } from "./types";

export function measuredLineAdvance(line: MeasuredLine): number {
  return line.lineHeight + (line.floatSkipBefore ?? 0);
}

export function measuredLineRangeHeight(
  lines: readonly MeasuredLine[],
  fromLine: number,
  toLine: number,
): number {
  let height = 0;
  const start = Math.max(0, fromLine);
  const end = Math.min(toLine, lines.length);

  for (let index = start; index < end; index++) {
    height += measuredLineAdvance(lines[index]!); // SAFETY: index < end <= lines.length
  }

  return height;
}

export function measuredLineContentOffset(
  lines: readonly MeasuredLine[],
  fromLine: number,
  lineIndex: number,
): number {
  const line = lines.at(lineIndex);
  return (
    measuredLineRangeHeight(lines, fromLine, lineIndex) +
    (line?.floatSkipBefore ?? 0)
  );
}
