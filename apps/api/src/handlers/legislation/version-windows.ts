import { panic } from "better-result";

import { LEGISLATION_WINDOW_DISPOSITION_BASES } from "@stll/api-contract/legislation-expression";
import { Temporal } from "@stll/time";

import type { LegislationExpressionClassification } from "@/api/lib/legal-search/legislation-expression-classification";
import type {
  VersionWindow,
  VersionWindowEnd,
} from "@/api/lib/legal-search/legislation-ingestion-types";

/** A window in the corpus's own terms: half-open, closing date exclusive. */
export type StoredWindow = {
  versionValidFrom: string | null;
  /** ISO date the window closes on (exclusive), or null while open. */
  versionValidTo: string | null;
};

/**
 * A connector's date, read strictly. `Temporal.PlainDate.from` would throw a
 * bare RangeError on "31.05.2025" from deep inside the pipeline; a connector
 * that hands over a date in any form but ISO is programmer misuse and is
 * named as such, with the value.
 */
const calendarDay = (isoDate: string): Temporal.PlainDate => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(isoDate)) {
    return panic("legislation version window date is not an ISO calendar day", {
      isoDate,
    });
  }
  return Temporal.PlainDate.from(isoDate);
};

/** The corpus's exclusive close for a publisher's stated end. */
const closingDay = (end: VersionWindowEnd): Temporal.PlainDate | null => {
  switch (end.type) {
    case "open":
      return null;
    case "exclusive":
      return calendarDay(end.on);
    case "last-day-in-force":
      return calendarDay(end.on).add({ days: 1 });
    default:
      end satisfies never;
      return panic("legislation version window end has no stored form", {
        end,
      });
  }
};

/**
 * How a stated window's two bounds relate, once converted: whether it has a
 * start at all, and whether it holds a day, none, or runs backwards.
 */
const windowShape = (
  opens: Temporal.PlainDate | null,
  closes: Temporal.PlainDate | null,
): "missing-start" | "open" | "positive" | "zero-length" | "reversed" => {
  if (opens === null) {
    return "missing-start";
  }
  if (closes === null) {
    return "open";
  }
  const order = Temporal.PlainDate.compare(closes, opens);
  if (order > 0) {
    return "positive";
  }
  return order === 0 ? "zero-length" : "reversed";
};

/**
 * The shape each basis names. A basis is the connector's reading of the dates
 * it passes, so one the dates contradict (a `reversed` window that holds a
 * day, a `missing-start` one with a start) is a connector defect, named here
 * rather than stored. A publisher's own never-in-force flag names no shape.
 */
const BASIS_SHAPES = {
  "zero-length-window": ["zero-length"],
  reversed: ["reversed"],
  "missing-start": ["missing-start"],
  // The publisher closes the version the day before it opens, because the
  // next one opens that day instead.
  "replaced-same-day": ["zero-length"],
  "publisher-flag": null,
} as const satisfies Record<
  Extract<VersionWindow, { basis: string }>["basis"],
  readonly ReturnType<typeof windowShape>[] | null
>;

/**
 * The publisher's window in the corpus's terms. The one place a publisher's
 * closing-date convention is converted: a connector declares it on
 * `VersionWindow` and never shifts a date itself, so every connector, present
 * and future, stores the same half-open bound.
 *
 * Only a window that can apply has to hold a day. One the connector declares
 * never in force or invalid is stored exactly as stated, and only has to be
 * the shape its basis names.
 */
export const storedWindow = (version: VersionWindow): StoredWindow => {
  if (version.type === "unversioned") {
    return { versionValidFrom: null, versionValidTo: null };
  }
  const opens =
    version.validFrom === null ? null : calendarDay(version.validFrom);
  const closes = closingDay(version.end);
  const shape = windowShape(opens, closes);
  if (version.type === "consolidation") {
    // A finite window closes after it opens, or it holds no day at all: an
    // empty or reversed window is a connector reading its publisher wrong,
    // and the junction check would not see it (it compares neighbours, not a
    // window with itself). One the publisher really states that way is
    // declared `invalid-window`.
    // Nor can a window with no start; the publisher's own start-less version
    // is `invalid-window` / `missing-start`.
    if (shape === "missing-start") {
      return panic("legislation version window has no start", {
        end: version.end,
      });
    }
    if (shape === "zero-length" || shape === "reversed") {
      return panic("legislation version window closes on or before it opens", {
        validFrom: opens?.toString(),
        validTo: closes?.toString(),
        end: version.end,
      });
    }
  } else {
    // Read as data, not trusted as typed: a connector may pass a basis its
    // disposition does not have, or one this contract does not know.
    const basesByDisposition: Readonly<
      Partial<Record<string, readonly string[]>>
    > = LEGISLATION_WINDOW_DISPOSITION_BASES;
    const bases = basesByDisposition[version.type];
    if (bases === undefined || !bases.includes(version.basis)) {
      return panic(
        "legislation version window basis is not its disposition's",
        {
          type: version.type,
          basis: version.basis,
        },
      );
    }
    const shapes: readonly string[] | null = BASIS_SHAPES[version.basis];
    if (shapes !== null && !shapes.includes(shape)) {
      return panic("legislation version window does not match its basis", {
        type: version.type,
        basis: version.basis,
        shape,
        validFrom: opens?.toString() ?? null,
        validTo: closes?.toString() ?? null,
      });
    }
  }
  return {
    versionValidFrom: opens?.toString() ?? null,
    versionValidTo: closes?.toString() ?? null,
  };
};

/**
 * Whether the publisher's window can answer a point-in-time read, and why not
 * when it cannot: what the connector declared, as the corpus stores it.
 */
export const windowDisposition = (
  version: VersionWindow,
): Pick<
  LegislationExpressionClassification,
  "windowDisposition" | "windowDispositionBasis"
> => {
  switch (version.type) {
    case "unversioned":
    case "consolidation":
      return { windowDisposition: "effective", windowDispositionBasis: null };
    case "never-in-force":
    case "invalid-window":
      return {
        windowDisposition: version.type,
        windowDispositionBasis: version.basis,
      };
    default:
      version satisfies never;
      return panic("legislation version window has no disposition", {
        version,
      });
  }
};

/**
 * How two adjacent consolidations of one work meet.
 *
 * The corpus window is half-open, `[version_valid_from, version_valid_to)`,
 * so a version's closing date is the day its successor opens and adjacent
 * windows meet edge to edge. The two ways a connector breaks that are both
 * connector defects, not corpus states:
 *
 * - `inclusive-end`: the earlier window closes the day before the later one
 *   opens. That is a publisher's inclusive end date (the last day in force)
 *   passed through unshifted, and it leaves that last day covered by no
 *   version, so a point-in-time read of it answers "uncovered" for a text the
 *   corpus holds.
 * - `overlap`: the earlier window closes after the later one opens, so the
 *   dates in between have two texts.
 *
 * A wider gap is `gap`: a version not yet ingested, which the coverage census
 * owns. An open earlier window (no closing date) is `open`: the connector has
 * not said when it ends, and nothing here can.
 */
export type WindowJunction =
  | { type: "contiguous" }
  | { type: "inclusive-end" }
  | { type: "overlap"; days: number }
  | { type: "gap"; days: number }
  | { type: "open" };

type Window = {
  /** ISO date the window opens on. */
  validFrom: string;
  /** ISO date the window closes on (exclusive), or null while open. */
  validTo: string | null;
};

export const windowJunction = (
  earlier: Window,
  later: Pick<Window, "validFrom">,
): WindowJunction => {
  if (earlier.validTo === null) {
    return { type: "open" };
  }
  const days = calendarDay(earlier.validTo).until(
    calendarDay(later.validFrom),
  ).days;
  if (days === 0) {
    return { type: "contiguous" };
  }
  if (days === 1) {
    return { type: "inclusive-end" };
  }
  if (days < 0) {
    return { type: "overlap", days: -days };
  }
  return { type: "gap", days };
};

/** A junction is a connector defect when it is one of these. */
const isDefectiveJunction = (
  junction: WindowJunction,
): junction is Extract<WindowJunction, { type: "inclusive-end" | "overlap" }> =>
  junction.type === "inclusive-end" || junction.type === "overlap";

/**
 * The defective junctions in a run of one work's versions, sorted by opening
 * date. The pipeline reads it over a version and its two neighbours at
 * ingest; a connector's fixture test reads it over every consolidation a
 * publisher capture yields and requires none. Same reading in both places,
 * so a connector that passes its own test cannot be one the pipeline later
 * reports.
 */
export const defectiveJunctions = (
  windows: readonly Window[],
): { earlier: Window; later: Window; junction: WindowJunction }[] => {
  const sorted = windows.toSorted((a, b) =>
    Temporal.PlainDate.compare(
      calendarDay(a.validFrom),
      calendarDay(b.validFrom),
    ),
  );
  const defects: {
    earlier: Window;
    later: Window;
    junction: WindowJunction;
  }[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const earlier = sorted[i - 1];
    const later = sorted[i];
    if (!earlier || !later) {
      continue;
    }
    const junction = windowJunction(earlier, later);
    if (isDefectiveJunction(junction)) {
      defects.push({ earlier, later, junction });
    }
  }
  return defects;
};
