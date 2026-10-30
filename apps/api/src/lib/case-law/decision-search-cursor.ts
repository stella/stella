/**
 * The Postgres branch's keyset cursor for case-law search: its one owner.
 *
 * A page boundary is a position in the order that produced it. The blended
 * relevance score and the decision date are two different orders over the same
 * decisions, so a boundary in one bounds nothing in the other: continuing a
 * relevance cursor into a date-ordered page would skip and repeat decisions
 * behind an ordinary-looking page. A cursor is therefore read only by the order
 * that issued it.
 *
 *     relevance: base64("<score>:relevance:<decisionId>")
 *     newest:    the date order's cursor (`decision-date-order.ts`), scoped to
 *                `newest`
 *
 * REMOVAL CONDITION: drop the one-segment legacy read once no replica issuing
 * `<sortKey>:<decisionId>` can still be serving. That form predates sorting
 * entirely, so `relevance` is what its page was ordered by, soundly.
 */

import { panic } from "better-result";

import { isUuid } from "@stll/uuid-codec";

import {
  type DecisionDatePosition,
  decodeDecisionDateCursor,
  encodeDecisionDateCursor,
} from "@/api/lib/case-law/decision-date-order";
import type { SearchSort } from "@/api/lib/legal-search/corpus-search-order";
import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";

const RELEVANCE = "relevance" satisfies SearchSort;
const NEWEST = "newest" satisfies SearchSort;

export type DecisionSearchCursor =
  | {
      sort: typeof RELEVANCE;
      /** The blended score of the last decision the page emitted. */
      sortKey: number;
      id: string;
    }
  | {
      sort: typeof NEWEST;
      position: DecisionDatePosition;
    };

export const encodeDecisionSearchCursor = (
  cursor: DecisionSearchCursor,
): string => {
  switch (cursor.sort) {
    case RELEVANCE:
      return encodeCursor(cursor.sortKey, `${RELEVANCE}:${cursor.id}`);
    case NEWEST:
      return encodeDecisionDateCursor(NEWEST, cursor.position);
    default:
      cursor satisfies never;
      return panic(`Unhandled search cursor: ${String(cursor)}`);
  }
};

const decodeRelevanceCursor = (cursor: string): DecisionSearchCursor | null => {
  const decoded = decodeCursor(cursor);
  if (decoded === null) {
    return null;
  }
  const segments = decoded.id.split(":");
  const id = segments.at(-1);
  if (id === undefined || !isUuid(id)) {
    return null;
  }
  switch (segments.length) {
    // legacy: `<sortKey>:<decisionId>`.
    case 1:
      return { sort: RELEVANCE, sortKey: decoded.score, id };
    case 2:
      return segments.at(0) === RELEVANCE
        ? { sort: RELEVANCE, sortKey: decoded.score, id }
        : null;
    // A decision id carrying a colon is not a cursor this service issued: the
    // grammar spends every segment it defines.
    default:
      return null;
  }
};

/** The position a cursor names in `sort`, or null for one `sort` did not issue. */
export const decodeDecisionSearchCursor = (
  cursor: string,
  sort: SearchSort,
): DecisionSearchCursor | null => {
  switch (sort) {
    case RELEVANCE:
      return decodeRelevanceCursor(cursor);
    case NEWEST: {
      const position = decodeDecisionDateCursor(cursor, NEWEST);
      return position === null ? null : { sort: NEWEST, position };
    }
    default:
      sort satisfies never;
      return panic(`Unhandled search sort: ${String(sort)}`);
  }
};
