import { panic } from "better-result";

import { Temporal } from "@stll/time";

import type { VersionWindow } from "@/api/lib/legal-search/legislation-ingestion-types";

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

/**
 * The publisher's window in the corpus's terms. The one place a publisher's
 * closing-date convention is converted: a connector declares it on
 * `VersionWindow` and never shifts a date itself, so every connector, present
 * and future, stores the same half-open bound.
 */
export const storedWindow = (version: VersionWindow): StoredWindow => {
  if (version.type === "unversioned") {
    return { versionValidFrom: null, versionValidTo: null };
  }
  const { end } = version;
  const opens = calendarDay(version.validFrom);
  const closes = ((): Temporal.PlainDate | null => {
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
  })();
  // A finite window closes after it opens, or it holds no day at all: an
  // empty or reversed window is a connector reading its publisher wrong, and
  // the junction check would not see it (it compares neighbours, not a
  // window with itself).
  if (closes !== null && Temporal.PlainDate.compare(closes, opens) <= 0) {
    return panic("legislation version window closes on or before it opens", {
      validFrom: opens.toString(),
      validTo: closes.toString(),
      end,
    });
  }
  return {
    versionValidFrom: opens.toString(),
    versionValidTo: closes?.toString() ?? null,
  };
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
export const isDefectiveJunction = (
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
