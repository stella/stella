import type { HeadingPathEntry } from "@stll/legal-ast";

export type ReaderBreadcrumbSegment = HeadingPathEntry;

export const compactReaderPath = (path: readonly ReaderBreadcrumbSegment[]) => {
  const first = path.at(0);
  if (path.length <= 3 || first === undefined) {
    return { visible: path, hidden: [] };
  }
  return { visible: [first, ...path.slice(-2)], hidden: path.slice(1, -2) };
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

/**
 * A heading as the trail prints it: the designation a reader navigates by
 * ("HLAVA III", "§ 7") and the title after it. A statute heading states them
 * on lines of their own; a provision number is the label wherever it stands.
 * A heading of one line and no number is all label.
 */
export type ReaderHeadingParts = {
  label: string;
  title: string | null;
};

export const splitReaderHeading = (heading: string): ReaderHeadingParts => {
  const lines = heading
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const number = readerProvisionNumber(heading);
  if (number !== null) {
    const rest = lines
      .map((line) =>
        line.startsWith(number) ? line.slice(number.length).trim() : line,
      )
      .filter((line) => line !== "")
      .join(" ");
    return { label: number, title: rest === "" ? null : rest };
  }
  const [label = "", ...rest] = lines;
  return { label, title: rest.length === 0 ? null : rest.join(" ") };
};

/** One crumb's natural widths, padding included: its label alone, and whole. */
type ReaderCrumbWidths = {
  label: number;
  full: number;
};

/**
 * How a crumb is printed: whole (its title cut to `width` when needed), as
 * its label alone, or folded into the menu of levels not on the bar.
 */
export type ReaderCrumbFit =
  | { type: "full"; width: number }
  | { type: "label"; width: number }
  | { type: "folded" };

type FitReaderPathOptions = {
  available: number;
  /** The visible levels outermost first; the last is the current heading. */
  crumbs: readonly ReaderCrumbWidths[];
  /** Levels already off the bar, which the menu lists whatever fits. */
  hiddenCount: number;
  separatorWidth: number;
  menuWidth: number;
  /** Less of a title than this says nothing; the label stands alone instead. */
  minimumTitleWidth: number;
  /** The widest an outer level's label is printed, cut beyond it. */
  maximumAncestorLabelWidth: number;
};

/** The width a crumb takes on the bar; a folded one takes none. */
export const fitWidth = (fit: ReaderCrumbFit | undefined): number =>
  fit === undefined || fit.type === "folded" ? 0 : fit.width;

/**
 * Spend the width on what a reader navigates by. Titles give way before
 * labels and outer levels before the current one: the outer titles go first,
 * outermost first, then the current title down to a readable minimum, then
 * outer levels fold into the menu, outermost first, and only then does the
 * current heading lose its title and, last of all, cut its own label.
 */
export const fitReaderPath = ({
  available,
  crumbs,
  hiddenCount,
  separatorWidth,
  menuWidth,
  minimumTitleWidth,
  maximumAncestorLabelWidth,
}: FitReaderPathOptions): {
  fits: ReaderCrumbFit[];
  showMenu: boolean;
} => {
  const lastIndex = crumbs.length - 1;
  const labelWidth = (index: number, crumb: ReaderCrumbWidths) =>
    index === lastIndex
      ? crumb.label
      : Math.min(crumb.label, maximumAncestorLabelWidth);
  const fits: ReaderCrumbFit[] = crumbs.map((crumb, index) =>
    crumb.full > crumb.label
      ? { type: "full", width: crumb.full }
      : { type: "label", width: labelWidth(index, crumb) },
  );
  const showMenu = () =>
    hiddenCount > 0 || fits.some((fit) => fit.type === "folded");
  const excess = () => {
    const shown = fits.filter((fit) => fit.type !== "folded").length;
    const items = shown + (showMenu() ? 1 : 0);
    return (
      fits.reduce((sum, fit) => sum + fitWidth(fit), 0) +
      (showMenu() ? menuWidth : 0) +
      Math.max(0, items - 1) * separatorWidth -
      available
    );
  };
  // Cut a title to what is left, or keep the label alone when too little of
  // the title would remain to say anything.
  const shrinkTitle = (index: number, floor: number) => {
    const crumb = crumbs[index];
    const fit = fits[index];
    if (crumb === undefined || fit?.type !== "full" || excess() <= 0) {
      return;
    }
    const width = Math.max(floor, fit.width - excess());
    fits[index] =
      width - crumb.label >= minimumTitleWidth
        ? { type: "full", width }
        : { type: "label", width: labelWidth(index, crumb) };
  };

  for (let index = 0; index < lastIndex; index += 1) {
    shrinkTitle(index, 0);
  }
  const current = crumbs.at(-1);
  if (current !== undefined) {
    shrinkTitle(lastIndex, current.label + minimumTitleWidth);
  }
  for (let index = 0; index < lastIndex && excess() > 0; index += 1) {
    fits[index] = { type: "folded" };
  }
  // A fold frees a whole level's width, more than the overflow it cured; the
  // current title takes the slack back.
  const shrunk = fits[lastIndex];
  if (current !== undefined && shrunk?.type === "full" && excess() < 0) {
    fits[lastIndex] = {
      type: "full",
      width: Math.min(current.full, shrunk.width - excess()),
    };
  }
  if (current !== undefined && excess() > 0) {
    shrinkTitle(lastIndex, 0);
  }
  const last = fits[lastIndex];
  if (last !== undefined && last.type !== "folded" && excess() > 0) {
    fits[lastIndex] = {
      type: "label",
      width: Math.max(0, last.width - excess()),
    };
  }
  return { fits, showMenu: showMenu() };
};
