import { Result } from "better-result";
import { expect, test } from "bun:test";

import { continuePausedTurnWhenReady } from "./continue-paused-turn.logic";

const run = async ({
  draftSaving = false,
  available = true,
  selection = Result.ok(undefined),
}: {
  draftSaving?: boolean;
  available?: boolean;
  selection?: Result<undefined, unknown>;
}) => {
  const continued: string[] = [];
  const result = await continuePausedTurnWhenReady({
    draftSaving,
    ensureAIAvailable: async () => await Promise.resolve(available),
    awaitPendingSelection: async () => await Promise.resolve(selection),
    continueTurn: () => {
      continued.push("turn");
    },
  });
  return { continued, result };
};

test("a paused turn does not continue while a generated draft is being saved", async () => {
  expect(await run({ draftSaving: true })).toEqual({
    continued: [],
    result: false,
  });
});

test("a paused turn does not continue when AI is unavailable", async () => {
  expect(await run({ available: false })).toEqual({
    continued: [],
    result: false,
  });
});

test("a paused turn does not continue when the pending model choice fails to land", async () => {
  expect(
    await run({ selection: Result.err(new Error("choice not stored")) }),
  ).toEqual({ continued: [], result: false });
});

test("a ready chat continues the paused turn", async () => {
  expect(await run({})).toEqual({ continued: ["turn"], result: true });
});
