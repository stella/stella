import { expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { enqueueDocumentTranslationRunJob } from "./run-queue";

const args = {
  organizationId: toSafeId<"organization">("org_test"),
  runId: toSafeId<"documentTranslationRun">(
    "00000000-0000-0000-0000-000000000001",
  ),
  userId: toSafeId<"user">("user_test"),
  workspaceId: toSafeId<"workspace">("00000000-0000-0000-0000-000000000002"),
};

type TranslationQueue = Parameters<
  typeof enqueueDocumentTranslationRunJob
>[0]["queue"];

test("replaces a completed queue job for a queued translation run", async () => {
  const add = mock(async () => undefined);
  const remove = mock(async () => undefined);
  const queue = asTestRaw<TranslationQueue>({
    add,
    getJob: mock(async () => ({
      getState: mock(async () => "completed"),
      remove,
    })),
  });

  await enqueueDocumentTranslationRunJob({ args, queue });

  expect(remove).toHaveBeenCalledTimes(1);
  expect(add).toHaveBeenCalledTimes(1);
});

test("retries a failed queue job instead of duplicating it", async () => {
  const add = mock(async () => undefined);
  const retry = mock(async () => undefined);
  const queue = asTestRaw<TranslationQueue>({
    add,
    getJob: mock(async () => ({
      getState: mock(async () => "failed"),
      retry,
    })),
  });

  await enqueueDocumentTranslationRunJob({ args, queue });

  expect(retry).toHaveBeenCalledTimes(1);
  expect(add).not.toHaveBeenCalled();
});
