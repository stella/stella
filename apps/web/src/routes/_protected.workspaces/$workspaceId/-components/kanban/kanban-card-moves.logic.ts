import { Result } from "better-result";

import { mapWithConcurrency } from "@stll/concurrency";

import type { KanbanDraggedCard } from "@/components/workspaces/kanban/kanban-selection.logic";

/**
 * Card writes in flight while a drop moves a selection. No endpoint moves
 * several cards at once, so a drop fans out per card; this keeps a large
 * selection from queueing every request behind the browser's per-origin
 * connection limit at once.
 */
export const KANBAN_MOVE_CONCURRENCY = 6;

type MoveKanbanCardsOptions = {
  cards: readonly KanbanDraggedCard[];
  /** Moves one card; an error result or a rejection counts it as failed. */
  moveCard: (card: KanbanDraggedCard) => Promise<Result<unknown, unknown>>;
};

export type KanbanCardMoveOutcome = {
  movedIds: string[];
  failures: unknown[];
};

/**
 * Attempt every card, whatever happens to the others: one failure must not
 * leave the rest of the selection where it was. The caller settles the batch
 * once (one refresh, one toast) from the outcome.
 */
export const moveKanbanCards = async ({
  cards,
  moveCard,
}: MoveKanbanCardsOptions): Promise<KanbanCardMoveOutcome> => {
  const results = await mapWithConcurrency({
    items: cards,
    limit: KANBAN_MOVE_CONCURRENCY,
    operation: async (card) => {
      const attempted = await Result.tryPromise({
        try: async () => await moveCard(card),
        catch: (cause) => cause,
      });
      return {
        card,
        result: Result.isError(attempted) ? attempted : attempted.value,
      };
    },
  });
  const movedIds: string[] = [];
  const failures: unknown[] = [];
  for (const { card, result } of results) {
    if (Result.isError(result)) {
      failures.push(result.error);
    } else {
      movedIds.push(card.entityId);
    }
  }
  return { movedIds, failures };
};
