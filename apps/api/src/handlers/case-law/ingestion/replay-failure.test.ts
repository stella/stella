import { expect, test } from "bun:test";

import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { S3ObjectBudgetError } from "@/api/lib/s3";

import {
  classifyReplayFailure,
  replayFailure,
  ReplayStageError,
} from "./replay-failure";

test("stored payload budgets and timeout causes produce stable content-free classes", () => {
  const budget = new S3ObjectBudgetError({
    message: "fixture object data must not be persisted",
    key: "fixture/raw",
    declaredBytes: 101,
    maxBytes: 100,
  });
  const timeout = new TimeoutError({
    message: "fixture object read timed out",
    label: "fixture/raw",
    timeoutMs: 10,
  });
  for (const cause of [
    timeout,
    new TypeError("outer fixture content", { cause: timeout }),
  ]) {
    expect(classifyReplayFailure(cause)).toEqual({
      code: "stored-raw-timeout",
      messageClass: "timeout",
    });
  }
  expect(classifyReplayFailure(budget)).toEqual({
    code: "stored-raw-too-large",
    messageClass: "payload-budget",
  });
  const adapter = new ReplayStageError({
    message: "fixture adapter detail",
    cause: new TypeError("fixture content"),
    failure: replayFailure("adapter-exception"),
  });
  expect(classifyReplayFailure(adapter)).toEqual({
    code: "adapter-exception",
    messageClass: "adapter",
  });
  expect(classifyReplayFailure(new TypeError("fixture secret"))).toEqual({
    code: "unexpected",
    messageClass: "unexpected",
  });
});
