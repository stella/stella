import { Temporal } from "@stll/time";

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
  const days = Temporal.PlainDate.from(earlier.validTo).until(
    Temporal.PlainDate.from(later.validFrom),
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
