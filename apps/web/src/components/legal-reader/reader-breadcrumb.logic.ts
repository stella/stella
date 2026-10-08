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
};

/** Spend the width on the current heading before its ancestors. */
export const fitReaderPath = ({
  available,
  naturalWidths,
  minimumWidths,
}: FitReaderPathOptions): readonly number[] => {
  const widths = [...naturalWidths];
  let excess = Math.max(
    0,
    widths.reduce((sum, width) => sum + width, 0) - available,
  );
  for (const [index, width] of widths.entries()) {
    const shrink = Math.min(
      excess,
      Math.max(0, width - (minimumWidths[index] ?? 0)),
    );
    widths[index] = width - shrink;
    excess -= shrink;
  }
  return widths;
};

export const readerProvisionNumber = (title: string): string | null =>
  /(?:^|\n)\s*(§\s*\d+[\p{L}\p{N}]*)/u.exec(title)?.at(1) ?? null;
