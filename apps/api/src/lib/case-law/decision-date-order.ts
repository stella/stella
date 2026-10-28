/**
 * Where a decision without a date goes when decisions are ordered by date: the
 * one rule for every date order (the browse listing in both directions, the
 * search's `newest`, a provision's citing decisions).
 *
 * An undated decision is listed, never hidden: the corpus keeps every decision
 * its source publishes. It comes last in both directions: it is neither the
 * newest nor the oldest, and placed first it would fill every oldest page. So
 * a date order is two bands read one after the other, the dated decisions in
 * the order's direction and then the undated ones, by id in the same
 * direction.
 */

import { panic } from "better-result";
import { asc, desc, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import type { DecisionListSort } from "@stll/api-contract/search";
import { isUuid } from "@stll/uuid-codec";

import type { SafeId } from "@/api/lib/branded-types";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

/** A date order: newest first or oldest first. */
type DecisionDateOrder = DecisionListSort;

/** The bands of a date order, in the order it reads them in both directions. */
export const DECISION_DATE_BANDS = ["dated", "undated"] as const;

export type DecisionDateBand = (typeof DECISION_DATE_BANDS)[number];

/** Where a date-ordered page ended: the last decision it listed. */
export type DecisionDatePosition =
  | {
      band: "dated";
      decisionDate: string;
      id: SafeId<"caseLawDecision">;
    }
  | {
      band: "undated";
      id: SafeId<"caseLawDecision">;
    };

/** The position of a listed row. */
export const decisionDatePositionOf = ({
  decisionDate,
  id,
}: {
  decisionDate: string | null;
  id: string;
}): DecisionDatePosition => {
  const decisionId = brandPersistedCaseLawDecisionId(id);
  return decisionDate === null
    ? { band: "undated", id: decisionId }
    : { band: "dated", decisionDate, id: decisionId };
};

/**
 * A page boundary, bound to `scope`: whatever a position in one listing is
 * not a position in (the order, or a digest of the request's filters).
 *
 *     base64url(JSON [scope, decisionDate | null, id])
 *
 * The null date is the undated band.
 */
export const encodeDecisionDateCursor = (
  scope: string,
  position: DecisionDatePosition,
): string => {
  switch (position.band) {
    case "dated":
      return encodePaginationCursor([
        scope,
        position.decisionDate,
        position.id,
      ]);
    case "undated":
      return encodePaginationCursor([scope, null, position.id]);
    default:
      position satisfies never;
      return panic(`Unhandled decision date band: ${String(position)}`);
  }
};

/** The position a cursor names, or null for one `scope` did not issue. */
export const decodeDecisionDateCursor = (
  cursor: string,
  scope: string,
): DecisionDatePosition | null => {
  const parts = decodePaginationCursor(cursor);
  if (parts?.length !== 3) {
    return null;
  }
  const [cursorScope, decisionDate, id] = parts;
  if (
    cursorScope !== scope ||
    typeof id !== "string" ||
    !isUuid(id) ||
    !(decisionDate === null || isDateOnlyPaginationCursorPart(decisionDate))
  ) {
    return null;
  }
  return decisionDatePositionOf({ decisionDate, id });
};

/**
 * The key the date indexes store: the decision date, with an undated decision
 * at `-infinity` (`case_law_decisions_country_date_published_idx`,
 * `case_law_decisions_country_court_date_idx`). Each band is one range of it:
 * the dated band above `-infinity`, the undated band at it.
 */
export const decisionDateSortKeySql = (decisionDate: SQLWrapper): SQL<string> =>
  sql<string>`coalesce(${decisionDate}, '-infinity'::date)`;

/** The rows of one band, stated on the indexed key so it bounds the range. */
export const decisionDateBandSql = (
  band: DecisionDateBand,
  decisionDate: SQLWrapper,
): SQL => {
  const key = decisionDateSortKeySql(decisionDate);
  switch (band) {
    case "dated":
      return sql`${key} > '-infinity'::date`;
    case "undated":
      return sql`${key} = '-infinity'::date`;
    default:
      band satisfies never;
      return panic(`Unhandled decision date band: ${String(band)}`);
  }
};

/** The bands left to read after a position, in reading order. */
export const decisionDateBandsFrom = (
  position: DecisionDatePosition | undefined,
): readonly DecisionDateBand[] =>
  position === undefined
    ? DECISION_DATE_BANDS
    : DECISION_DATE_BANDS.slice(DECISION_DATE_BANDS.indexOf(position.band));

/** The direction each order reads its key and its id in. */
const DECISION_DATE_DIRECTIONS = {
  newest: desc,
  oldest: asc,
} as const satisfies Record<DecisionDateOrder, (column: SQLWrapper) => SQL>;

type DecisionDateColumns = {
  decisionDate: SQLWrapper;
  id: SQLWrapper;
};

/**
 * One band's ORDER BY: the indexed key, then id, both in the order's
 * direction, so either index serves the band as a range read one way.
 */
export const decisionDateBandOrderBySql = (
  order: DecisionDateOrder,
  { decisionDate, id }: DecisionDateColumns,
): SQL[] => {
  const direction = DECISION_DATE_DIRECTIONS[order];
  return [direction(decisionDateSortKeySql(decisionDate)), direction(id)];
};

type DecisionDateBandAfterOptions = {
  order: DecisionDateOrder;
  position: DecisionDatePosition;
  columns: DecisionDateColumns;
};

/**
 * Rows after a position within the position's own band: one row comparison
 * on the expressions the band's ORDER BY reads, so the two cannot drift.
 */
export const decisionDateBandAfterSql = ({
  order,
  position,
  columns,
}: DecisionDateBandAfterOptions): SQL => {
  const key = sql`(${decisionDateSortKeySql(columns.decisionDate)}, ${columns.id})`;
  const at = sql`(${decisionDateSortKeySql(sql`${positionDate(position)}::date`)}, ${position.id}::uuid)`;
  switch (order) {
    case "newest":
      return sql`${key} < ${at}`;
    case "oldest":
      return sql`${key} > ${at}`;
    default:
      order satisfies never;
      return panic(`Unhandled decision date order: ${String(order)}`);
  }
};

const positionDate = (position: DecisionDatePosition): string | null => {
  switch (position.band) {
    case "dated":
      return position.decisionDate;
    case "undated":
      return null;
    default:
      position satisfies never;
      return panic(`Unhandled decision date band: ${String(position)}`);
  }
};

/**
 * Where an undated decision ranks in one sorted pass over an order: past the
 * order's far end, so sorting by the rank in the order's direction lists the
 * dated band and then the undated one. For a statement that sorts the rows it
 * matched; a walk that must stay an index range reads the bands instead.
 */
const UNDATED_RANK = {
  newest: sql.raw("'-infinity'::date"),
  oldest: sql.raw("'infinity'::date"),
} as const satisfies Record<DecisionDateOrder, SQL>;

/** A decision's rank in one sorted pass over `order`. */
export const decisionDateRankSql = (
  order: DecisionDateOrder,
  decisionDate: SQLWrapper,
): SQL => sql`coalesce(${decisionDate}, ${UNDATED_RANK[order]})`;

type DecisionDateRankAfterOptions = {
  order: DecisionDateOrder;
  position: DecisionDatePosition;
  /** The row's rank, as `decisionDateRankSql` computes it. */
  rank: SQLWrapper;
  id: SQLWrapper;
};

/** Rows after a position in one sorted pass, compared on the rank. */
export const decisionDateRankAfterSql = ({
  order,
  position,
  rank,
  id,
}: DecisionDateRankAfterOptions): SQL => {
  const row = sql`(${rank}, ${id})`;
  const at = sql`(${decisionDateRankSql(order, sql`${positionDate(position)}::date`)}, ${position.id}::uuid)`;
  switch (order) {
    case "newest":
      return sql`${row} < ${at}`;
    case "oldest":
      return sql`${row} > ${at}`;
    default:
      order satisfies never;
      return panic(`Unhandled decision date order: ${String(order)}`);
  }
};

/** One sorted pass's ORDER BY: the rank, then id, in the order's direction. */
export const decisionDateRankOrderBySql = (
  order: DecisionDateOrder,
  { rank, id }: { rank: SQLWrapper; id: SQLWrapper },
): SQL[] => {
  const direction = DECISION_DATE_DIRECTIONS[order];
  return [direction(rank), direction(id)];
};
