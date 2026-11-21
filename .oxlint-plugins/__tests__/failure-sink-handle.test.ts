import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects inline runtime selected and computed sink values", async () => {
  expect(
    await lintSingleRule(
      "failure-sink-handle",
      'observeFailure(error, { sink: failureSink({ event: "failed", expected: [] }) });\nobserveFailure(error, { sink: pickSink(kind) });\nobserveFailure(error, { sink: sinks[kind] });',
    ),
  ).toEqual([1, 1, 2, 3]);
});

test("rejects hidden options and spread options", async () => {
  expect(
    await lintSingleRule(
      "failure-sink-handle",
      "observeFailure(error, options);\nobserveFailure(error, { ...defaults, ctx });",
    ),
  ).toEqual([1, 2]);
});

test("rejects handles created per call or in mutable module declarations", async () => {
  expect(
    await lintSingleRule(
      "failure-sink-handle",
      'function run() { const handle = failureSink({ event: "failed", expected: [] }); }\nlet handle = failureSink({ event: "failed", expected: [] });',
    ),
  ).toEqual([1, 2]);
});

test("accepts module const handles and imported handles", async () => {
  expect(
    await lintSingleRule(
      "failure-sink-handle",
      'import { workerFailed as imported } from "./sinks";\nconst failed = failureSink({ event: "failed", expected: [] });\nobserveFailure(error, { sink: failed });\nobserveFailure(error, { sink: imported });',
    ),
  ).toEqual([]);
});

test("accepts declared object handles and calls without a sink", async () => {
  expect(
    await lintSingleRule(
      "failure-sink-handle",
      'export const SINKS = { worker: failureSink({ event: "failed", expected: [] }) };\nobserveFailure(error, { ctx });',
    ),
  ).toEqual([]);
});
