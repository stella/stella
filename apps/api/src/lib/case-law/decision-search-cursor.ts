/**
 * The Postgres branch's keyset cursor for case-law search: its one owner.
 *
 * A page boundary is a position in the order that produced it. The blended
 * relevance score and the decision date are two different orders over the same
 * decisions, so a boundary in one bounds nothing in the other: continuing a
 * relevance cursor into a date-ordered page would skip and repeat decisions
 * behind an ordinary-looking page. The order therefore travels with the key.
 *
 *     base64("<sortKey>:<sort>:<decisionId>")
 *
 * REMOVAL CONDITION: drop the one-segment legacy read once no replica issuing
 * `<sortKey>:<decisionId>` can still be serving. That form predates sorting
 * entirely, so `relevance` is what its page was ordered by, soundly.
 */

import { isUuid } from "@/api/lib/custom-schema";
import {
  DEFAULT_SEARCH_SORT,
  SEARCH_SORTS,
  type SearchSort,
} from "@/api/lib/legal-search/corpus-search-order";
import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";

export type DecisionSearchCursor = {
  /** The ordering column's value on the last decision the page emitted. */
  sortKey: number;
  sort: SearchSort;
  id: string;
};

export const encodeDecisionSearchCursor = ({
  id,
  sort,
  sortKey,
}: DecisionSearchCursor): string => encodeCursor(sortKey, `${sort}:${id}`);

export const decodeDecisionSearchCursor = (
  cursor: string,
): DecisionSearchCursor | null => {
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
      return { id, sort: DEFAULT_SEARCH_SORT, sortKey: decoded.score };
    case 2: {
      const sort = SEARCH_SORTS.find((value) => value === segments.at(0));
      return sort === undefined ? null : { id, sort, sortKey: decoded.score };
    }
    // A decision id carrying a colon is not a cursor this service issued: the
    // grammar spends every segment it defines.
    default:
      return null;
  }
};
