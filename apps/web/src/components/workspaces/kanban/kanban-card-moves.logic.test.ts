import { describe, expect, test } from "bun:test";

import {
  KANBAN_MOVE_CONCURRENCY,
  moveKanbanCards,
} from "./kanban-card-moves.logic";

const cards = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    entityId: `card-${index}`,
    subgroupValue: undefined,
  }));

describe("moving a selection of cards", () => {
  test("attempts every card even when some fail, and reports which moved", async () => {
    const attempted: string[] = [];
    const failure = new Error("card-1 refused");

    const outcome = await moveKanbanCards({
      cards: cards(4),
      moveCard: async ({ entityId }) => {
        attempted.push(entityId);
        if (entityId === "card-1") {
          throw failure;
        }
        await Promise.resolve();
      },
    });

    expect(attempted.toSorted()).toEqual([
      "card-0",
      "card-1",
      "card-2",
      "card-3",
    ]);
    expect(outcome.movedIds).toEqual(["card-0", "card-2", "card-3"]);
    // The original error survives, so the toast can show its message.
    expect(outcome.failures).toEqual([failure]);
  });

  test("keeps at most the bounded number of moves in flight", async () => {
    let inFlight = 0;
    let peak = 0;

    await moveKanbanCards({
      cards: cards(KANBAN_MOVE_CONCURRENCY * 3),
      moveCard: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Every started move yields before settling, so the pool fills up
        // before the first one finishes.
        await Promise.resolve();
        inFlight -= 1;
      },
    });

    expect(peak).toBe(KANBAN_MOVE_CONCURRENCY);
  });
});
