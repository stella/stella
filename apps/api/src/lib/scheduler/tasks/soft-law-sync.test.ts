import { Result } from "better-result";
import { expect, mock, test } from "bun:test";

import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { createSoftLawSyncTask } from "./soft-law-sync";

const contextOf = (signal: AbortSignal) =>
  asTestRaw<SchedulerTaskContext>({
    logger: { info: () => undefined },
    signal,
  });

test("a source whose sync rejects fails alone and later sources still sync", async () => {
  const synced: string[] = [];
  const task = createSoftLawSyncTask({
    authorities: () => ["first", "second"],
    sync: mock(async ({ authority }: { authority: string }) => {
      synced.push(authority);
      if (authority === "first") {
        throw new Error("settlement failed");
      }
      return await Promise.resolve({ status: "complete" });
    }),
  });

  const outcome = await task(contextOf(new AbortController().signal));

  expect(synced).toEqual(["first", "second"]);
  expect(outcome !== undefined && Result.isError(outcome)).toBe(true);
  expect(
    outcome !== undefined && Result.isError(outcome)
      ? outcome.error.message
      : undefined,
  ).toBe("Soft-law sync failed for first");
});

test("an aborted run stops instead of failing the remaining sources", async () => {
  const controller = new AbortController();
  const synced: string[] = [];
  const task = createSoftLawSyncTask({
    authorities: () => ["first", "second"],
    sync: async ({ authority }: { authority: string }) => {
      synced.push(authority);
      controller.abort();
      return await Promise.reject(new Error("aborted mid-sync"));
    },
  });

  const run = Result.tryPromise({
    try: async () => await task(contextOf(controller.signal)),
    catch: (error: unknown) => error,
  });

  const settled = await run;
  expect(Result.isError(settled)).toBe(true);
  expect(synced).toEqual(["first"]);
});
