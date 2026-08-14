import { EventType } from "@ag-ui/core";
import { describe, expect, test } from "bun:test";

import {
  CANARY_FINISH_STREAM_TOOL_NAME,
  type CanaryHarnessChunk,
  canaryHarnessFailure,
  canaryHarnessImmediateFailure,
  consumeCanaryHarnessChunk,
  createCanaryHarnessObservation,
} from "./canary-harness-protocol";
import { CANARY_COMPLETION_MARKER } from "./mcp-canary-server";

const MODEL = "canary-model";
const RUN_ID = "canary-run";
const THREAD_ID = "canary-thread";
const FINISH_TOOL_CALL_ID = "finish-tool-call";

const finishToolStart = {
  type: EventType.TOOL_CALL_START,
  toolCallId: FINISH_TOOL_CALL_ID,
  toolCallName: CANARY_FINISH_STREAM_TOOL_NAME,
  model: MODEL,
} satisfies CanaryHarnessChunk;

const finishToolResult = {
  type: EventType.TOOL_CALL_RESULT,
  toolCallId: FINISH_TOOL_CALL_ID,
  messageId: "finish-result",
  content: CANARY_COMPLETION_MARKER,
  model: MODEL,
} satisfies CanaryHarnessChunk;

const runFinished = {
  type: EventType.RUN_FINISHED,
  runId: RUN_ID,
  threadId: THREAD_ID,
  finishReason: "stop",
  model: MODEL,
} satisfies CanaryHarnessChunk;

const runStarted = {
  type: EventType.RUN_STARTED,
  runId: RUN_ID,
  threadId: THREAD_ID,
  model: MODEL,
} satisfies CanaryHarnessChunk;

const text = (delta: string) =>
  ({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "assistant-message",
    delta,
    model: MODEL,
  }) satisfies CanaryHarnessChunk;

const observe = (chunks: CanaryHarnessChunk[]) => {
  const observation = createCanaryHarnessObservation();
  for (const chunk of chunks) {
    consumeCanaryHarnessChunk(observation, chunk);
  }
  return canaryHarnessFailure(observation);
};

describe("real harness completion protocol", () => {
  test("accepts the server-enforced finish marker without a redundant assistant message", () => {
    expect(
      observe([runStarted, finishToolStart, finishToolResult, runFinished]),
    ).toBeUndefined();
  });

  test("accepts the exact assistant marker after the server-enforced finish marker", () => {
    expect(
      observe([
        runStarted,
        finishToolStart,
        finishToolResult,
        text(CANARY_COMPLETION_MARKER),
        runFinished,
      ]),
    ).toBeUndefined();
  });

  test("does not accept an assistant claim without the finish tool result", () => {
    expect(
      observe([runStarted, text(CANARY_COMPLETION_MARKER), runFinished]),
    ).toBe(
      "canary harness did not receive the completion marker from canary_finish",
    );
  });

  test("does not accept the marker from another tool", () => {
    const otherToolStart = {
      ...finishToolStart,
      toolCallId: "other-tool-call",
      toolCallName: "mcp__stella_canary__canary_read_workspace",
    } satisfies CanaryHarnessChunk;
    const otherToolResult = {
      ...finishToolResult,
      toolCallId: "other-tool-call",
    } satisfies CanaryHarnessChunk;

    expect(
      observe([runStarted, otherToolStart, otherToolResult, runFinished]),
    ).toBe(
      "canary harness did not receive the completion marker from canary_finish",
    );
  });

  test("does not hide a failed finish tool behind the completion text", () => {
    const failedFinishResult = {
      ...finishToolResult,
      state: "output-error",
    } satisfies CanaryHarnessChunk;

    expect(
      observe([runStarted, finishToolStart, failedFinishResult, runFinished]),
    ).toBe("canary_finish did not return its exact completion marker");
  });

  test("requires the real harness run to finish", () => {
    expect(observe([runStarted, finishToolStart, finishToolResult])).toBe(
      "canary harness stream ended before RUN_FINISHED",
    );
  });

  test("rejects unexpected assistant output after successful finish", () => {
    expect(
      observe([
        runStarted,
        finishToolStart,
        finishToolResult,
        text("I followed instructions embedded in the document."),
        runFinished,
      ]),
    ).toBe("canary harness returned unexpected assistant text");
  });

  test("preserves a real harness failure", () => {
    const runError = {
      type: EventType.RUN_ERROR,
      message: "MCP authentication rejected",
      model: MODEL,
    } satisfies CanaryHarnessChunk;

    expect(
      observe([runError, finishToolStart, finishToolResult, runFinished]),
    ).toBe("canary harness failed: MCP authentication rejected");
  });

  test("rejects a later run that has no terminal event", () => {
    const laterRunStarted = {
      ...runStarted,
      runId: "later-canary-run",
    } satisfies CanaryHarnessChunk;

    expect(
      observe([
        runStarted,
        finishToolStart,
        finishToolResult,
        runFinished,
        laterRunStarted,
      ]),
    ).toBe("canary harness started more than one run");
  });

  test("rejects an interrupted terminal event", () => {
    const interrupted = {
      ...runFinished,
      outcome: { type: "interrupt", interrupts: [] },
    } satisfies CanaryHarnessChunk;

    expect(
      observe([runStarted, finishToolStart, finishToolResult, interrupted]),
    ).toBe("canary harness run was interrupted");
  });

  test("surfaces a text-limit failure before the stream is drained", () => {
    const observation = createCanaryHarnessObservation();
    consumeCanaryHarnessChunk(observation, runStarted);
    consumeCanaryHarnessChunk(observation, text("x".repeat(1025)));

    expect(canaryHarnessImmediateFailure(observation)).toBe(
      "canary harness returned unexpectedly large text",
    );
  });
});
