import type { HeadingPathEntry } from "@stll/legal-ast";

export type ReaderBreadcrumbSegment = HeadingPathEntry;

export const compactReaderPath = (path: readonly ReaderBreadcrumbSegment[]) => {
  const first = path.at(0);
  if (path.length <= 3 || first === undefined) {
    return { visible: path, hidden: [] };
  }
  return { visible: [first, ...path.slice(-2)], hidden: path.slice(1, -2) };
};

type FitReaderPathOptions = {
  available: number;
  naturalWidths: readonly number[];
  minimumWidths: readonly number[];
  separatorWidth?: number;
  middleWidth?: number;
};

/** Spend the width on the current heading before its ancestors. */
export const fitReaderPath = ({
  available,
  naturalWidths,
  minimumWidths,
  separatorWidth = 0,
  middleWidth = 0,
}: FitReaderPathOptions) => {
  const widths = [...naturalWidths];
  const minimums = [...minimumWidths];
  let showMiddle = middleWidth > 0;
  const reserved = () =>
    Math.max(0, widths.filter((width) => width > 0).length - 1) *
      separatorWidth +
    (showMiddle ? middleWidth : 0);
  for (let index = 0; index < widths.length - 1; index += 1) {
    const minimum = minimums.reduce((sum, width) => sum + width, 0);
    if (minimum + reserved() <= available) {
      break;
    }
    showMiddle = false;
    widths[index] = 0;
    minimums[index] = 0;
  }
  let excess = Math.max(
    0,
    widths.reduce((sum, width) => sum + width, 0) -
      Math.max(0, available - reserved()),
  );
  for (const [index, width] of widths.entries()) {
    const shrink = Math.min(
      excess,
      Math.max(0, width - (minimums[index] ?? 0)),
    );
    widths[index] = width - shrink;
    excess -= shrink;
  }
  return { widths, showMiddle };
};

export const readerProvisionNumber = (title: string): string | null => {
  for (const line of title.split("\n")) {
    const number = /^(§\s*\d+\p{L}*)/u.exec(line.trimStart())?.at(1);
    if (number !== undefined) {
      return number;
    }
  }
  return null;
};
