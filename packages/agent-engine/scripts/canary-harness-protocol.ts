import { EventType } from "@ag-ui/core";
import type { StreamChunk } from "@tanstack/ai";
import { tanstackMetadata } from "@tanstack/ai/adapter-internals";
import { panic } from "better-result";

import {
  CANARY_COMPLETION_MARKER,
  CANARY_FINISH_TOOL_NAME,
} from "./mcp-canary-server";

export const CANARY_MCP_SERVER_NAME = "stella_canary";
export const CANARY_FINISH_STREAM_TOOL_NAME = `mcp__${CANARY_MCP_SERVER_NAME}__${CANARY_FINISH_TOOL_NAME}`;
const CANARY_FINISH_COMPLETED_RESULT = JSON.stringify({
  status: "completed",
});

export type CanaryHarnessChunk = StreamChunk;

export type CanaryHarnessObservation = {
  assistantText: string;
  finishResult:
    | { status: "pending" }
    | { status: "observed"; toolCallId: string }
    | { status: "failed"; message: string };
  finishToolCallIds: Set<string>;
  hasStarted: boolean;
  runStatus:
    | { status: "streaming" }
    | { status: "finished" }
    | { status: "failed"; message: string };
};

export const createCanaryHarnessObservation = (): CanaryHarnessObservation => ({
  assistantText: "",
  finishResult: { status: "pending" },
  finishToolCallIds: new Set(),
  hasStarted: false,
  runStatus: { status: "streaming" },
});

/**
 * The Codex adapter may project an MCP tool's opaque result as a text marker,
 * structured JSON, or a synthesized interruption status. None of those
 * transport representations proves the server completed the canary sequence;
 * that proof comes only from the authenticated server state asserted after the
 * stream. Keep diagnostic output bounded so an arbitrary tool payload cannot
 * be published in the protected workflow log.
 */
const finishResultShape = (content: string): string => {
  if (content === "") {
    return "empty";
  }
  if (content === CANARY_COMPLETION_MARKER) {
    return "completion-marker";
  }
  if (content === CANARY_FINISH_COMPLETED_RESULT) {
    return "completed-status";
  }
  if (content === JSON.stringify({ status: "interrupted" })) {
    return "interrupted-status";
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return "json-array";
    }
    if (parsed === null) {
      return "json-null";
    }
    if (typeof parsed === "object") {
      return "json-object";
    }
    return "json-scalar";
  } catch {
    return "text";
  }
};

/**
 * Observe the correlated finish-tool result and optional assistant text. The
 * authenticated server state asserted after the stream proves the protected
 * MCP sequence; a tool result only proves the call resolved without an
 * explicit adapter error.
 */
export const consumeCanaryHarnessChunk = (
  observation: CanaryHarnessObservation,
  chunk: CanaryHarnessChunk,
): void => {
  if (canaryHarnessImmediateFailure(observation) !== undefined) {
    return;
  }
  switch (chunk.type) {
    case EventType.RUN_ERROR:
      observation.runStatus = {
        status: "failed",
        message: `canary harness failed: ${chunk.message}`,
      };
      return;
    case EventType.TEXT_MESSAGE_CONTENT:
      observation.assistantText += chunk.delta;
      if (observation.assistantText.length > 1024) {
        observation.runStatus = {
          status: "failed",
          message: "canary harness returned unexpectedly large text",
        };
      }
      return;
    case EventType.RUN_FINISHED:
      if (chunk.outcome?.type === "interrupt") {
        observation.runStatus = {
          status: "failed",
          message: "canary harness run was interrupted",
        };
        return;
      }
      if (
        !observation.hasStarted ||
        observation.runStatus.status !== "streaming"
      ) {
        observation.runStatus = {
          status: "failed",
          message: "canary harness finished without an active run",
        };
        return;
      }
      observation.runStatus = { status: "finished" };
      return;
    case EventType.RUN_STARTED:
      if (observation.hasStarted) {
        observation.runStatus = {
          status: "failed",
          message: "canary harness started more than one run",
        };
        return;
      }
      observation.hasStarted = true;
      return;
    case "TOOL_CALL_START":
      if (chunk.toolCallName !== CANARY_FINISH_STREAM_TOOL_NAME) {
        return;
      }
      if (observation.finishToolCallIds.size !== 0) {
        observation.finishResult = {
          status: "failed",
          message: "canary harness called canary_finish more than once",
        };
      }
      observation.finishToolCallIds.add(chunk.toolCallId);
      return;
    case EventType.TOOL_CALL_RESULT: {
      if (!observation.finishToolCallIds.has(chunk.toolCallId)) {
        return;
      }
      if (observation.finishResult.status !== "pending") {
        observation.finishResult = {
          status: "failed",
          message: "canary harness returned multiple canary_finish results",
        };
        return;
      }
      if (tanstackMetadata(chunk)?.state === "output-error") {
        observation.finishResult = {
          status: "failed",
          message: `canary_finish returned output-error (content shape: ${finishResultShape(chunk.content)})`,
        };
        return;
      }
      observation.finishResult = {
        status: "observed",
        toolCallId: chunk.toolCallId,
      };
      return;
    }
    case "CUSTOM":
    case EventType.MESSAGES_SNAPSHOT:
    case EventType.REASONING_ENCRYPTED_VALUE:
    case EventType.REASONING_END:
    case EventType.REASONING_MESSAGE_CONTENT:
    case EventType.REASONING_MESSAGE_END:
    case EventType.REASONING_MESSAGE_START:
    case EventType.REASONING_START:
    case EventType.STATE_DELTA:
    case EventType.STATE_SNAPSHOT:
    case EventType.STEP_FINISHED:
    case EventType.STEP_STARTED:
    case EventType.TEXT_MESSAGE_END:
    case EventType.TEXT_MESSAGE_START:
    case EventType.TOOL_CALL_ARGS:
    case "TOOL_CALL_END":
      return;
    default: {
      chunk satisfies never;
      return panic(`Unhandled chunk: ${String(chunk)}`);
    }
  }
};

/**
 * Surface a terminal protocol failure while the stream is still being read so
 * the caller stops a runaway harness instead of draining more output.
 */
export const canaryHarnessImmediateFailure = (
  observation: CanaryHarnessObservation,
): string | undefined => {
  if (observation.runStatus.status === "failed") {
    return observation.runStatus.message;
  }
  if (observation.finishResult.status === "failed") {
    return observation.finishResult.message;
  }
  return undefined;
};

export const canaryHarnessFailure = (
  observation: CanaryHarnessObservation,
): string | undefined => {
  if (observation.runStatus.status === "failed") {
    return observation.runStatus.message;
  }
  if (observation.finishResult.status === "failed") {
    return observation.finishResult.message;
  }
  if (observation.runStatus.status !== "finished") {
    return "canary harness stream ended before RUN_FINISHED";
  }
  if (!observation.hasStarted) {
    return "canary harness stream ended without RUN_STARTED";
  }
  if (observation.finishResult.status !== "observed") {
    return "canary harness did not receive a non-error result from canary_finish";
  }
  const assistantText = observation.assistantText.trim();
  if (assistantText !== "" && assistantText !== CANARY_COMPLETION_MARKER) {
    return "canary harness returned unexpected assistant text";
  }
  return undefined;
};
