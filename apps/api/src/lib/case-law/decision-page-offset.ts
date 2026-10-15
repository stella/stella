import { t } from "elysia";

import { LIMITS } from "@/api/lib/limits";

/**
 * How far into a list of decisions a page begins, for a page addressed by
 * number rather than reached by a chain of cursors. Bounded in the schema so
 * a request past the deepest result is refused before it reaches a handler.
 */
export const tDecisionPageOffset = () =>
  t.Integer({ minimum: 0, maximum: LIMITS.caseLawResultDepthMax - 1 });

export const DECISION_PAGE_CURSOR_AND_OFFSET_MESSAGE =
  "A page is addressed by cursor or by offset, not both";

export const DECISION_PAGE_BEYOND_DEPTH_MESSAGE = `A page may reach at most result ${String(LIMITS.caseLawResultDepthMax)} (offset + limit); refine the search to see more`;

type DecisionPagePosition = {
  cursor?: string | undefined;
  offset?: number | undefined;
};

type DecisionPagePlacement = {
  /** Ranked results ahead of the page; zero for a cursor page. */
  offset: number;
  /**
   * Whether this page is where the result set starts. Only that page reads
   * what describes the whole set (its total, its facets); every page reached
   * by cursor or by offset is a slice of a set it already described.
   */
  isFirstPage: boolean;
};

/** Where an admitted page request begins. */
export const decisionPagePlacement = ({
  cursor,
  offset = 0,
}: DecisionPagePosition): DecisionPagePlacement => ({
  offset,
  isFirstPage: cursor === undefined && offset === 0,
});

type DecisionPageRequest = {
  cursor: string | undefined;
  offset: number | undefined;
  /** The page size the handler will apply, after its own default. */
  limit: number;
};

/**
 * Why a page request cannot be served, or null when it can. Checked before
 * any read: an offset page ranks every result in front of it, so a page past
 * the depth bound would be a slow query rather than a page.
 */
export const decisionPageRequestRefusal = ({
  cursor,
  limit,
  offset,
}: DecisionPageRequest): string | null => {
  if (offset === undefined) {
    return null;
  }
  if (cursor !== undefined) {
    return DECISION_PAGE_CURSOR_AND_OFFSET_MESSAGE;
  }
  return offset + limit > LIMITS.caseLawResultDepthMax
    ? DECISION_PAGE_BEYOND_DEPTH_MESSAGE
    : null;
};
