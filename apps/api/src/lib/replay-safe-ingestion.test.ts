import { describe, expect, test } from "bun:test";

import { commitReplaySafeIngestionBatch } from "@/api/lib/replay-safe-ingestion";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";

type State = {
  checkpoint: string | null;
  items: Set<string>;
};

type FakeTransaction = {
  state: State;
};

const createTransactionRunner =
  (state: State): IngestionTransactionRunner<FakeTransaction> =>
  async (work) => {
    const pending = {
      checkpoint: state.checkpoint,
      items: new Set(state.items),
    };
    const result = await work({ state: pending });
    state.checkpoint = pending.checkpoint;
    state.items = pending.items;
    return result;
  };

const persistItems = async (
  transaction: FakeTransaction,
  items: readonly string[],
) => {
  for (const item of items) {
    transaction.state.items.add(item);
  }
  return transaction.state.items.size;
};

const persistCheckpoint = async (
  transaction: FakeTransaction,
  checkpoint: string,
) => {
  transaction.state.checkpoint = checkpoint;
};

describe("commitReplaySafeIngestionBatch", () => {
  test("replaying a committed batch reaches the same fixed point", async () => {
    const state: State = { checkpoint: null, items: new Set<string>() };
    const runInTransaction = createTransactionRunner(state);
    const commit = async () =>
      await commitReplaySafeIngestionBatch({
        checkpoint: "page-2",
        items: ["a", "b"],
        persistCheckpoint,
        persistItems,
        runInTransaction,
      });

    expect(await commit()).toBe(2);
    expect(await commit()).toBe(2);
    expect(state.checkpoint).toBe("page-2");
    expect([...state.items]).toEqual(["a", "b"]);
  });

  test("does not advance the checkpoint when item persistence fails", async () => {
    const state: State = {
      checkpoint: "page-1",
      items: new Set<string>(),
    };

    const rejection: unknown = await commitReplaySafeIngestionBatch({
      checkpoint: "page-2",
      items: ["a"],
      persistCheckpoint,
      persistItems: async () => {
        throw new Error("item persistence failed");
      },
      runInTransaction: createTransactionRunner(state),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    if (!(rejection instanceof Error)) {
      throw new Error("expected item persistence to reject");
    }

    expect(rejection.message).toBe("item persistence failed");
    expect(state.checkpoint).toBe("page-1");
    expect(state.items.size).toBe(0);
  });

  test("rolls item writes back when checkpoint persistence fails", async () => {
    const state: State = {
      checkpoint: "page-1",
      items: new Set<string>(),
    };

    const rejection: unknown = await commitReplaySafeIngestionBatch({
      checkpoint: "page-2",
      items: ["a"],
      persistCheckpoint: async () => {
        throw new Error("checkpoint persistence failed");
      },
      persistItems,
      runInTransaction: createTransactionRunner(state),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    if (!(rejection instanceof Error)) {
      throw new Error("expected checkpoint persistence to reject");
    }

    expect(rejection.message).toBe("checkpoint persistence failed");
    expect(state.checkpoint).toBe("page-1");
    expect(state.items.size).toBe(0);
  });
});
