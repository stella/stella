import { EventType } from "@ag-ui/core";
import type { StreamChunk } from "@tanstack/ai";

import {
  CANARY_COMPLETION_MARKER,
  CANARY_FINISH_TOOL_NAME,
} from "./mcp-canary-server";

export const CANARY_MCP_SERVER_NAME = "stella_canary";
export const CANARY_FINISH_STREAM_TOOL_NAME = `mcp__${CANARY_MCP_SERVER_NAME}__${CANARY_FINISH_TOOL_NAME}`;
const CANARY_FINISH_COMPLETED_RESULT = JSON.stringify({
  status: "completed",
});

type ToolCallStartChunk = Extract<StreamChunk, { type: "TOOL_CALL_START" }>;

export type CanaryHarnessChunk =
  | Exclude<StreamChunk, ToolCallStartChunk>
  | Omit<ToolCallStartChunk, "toolName">;

export type CanaryHarnessObservation = {
  assistantText: string;
  completion:
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
  completion: { status: "pending" },
  finishToolCallIds: new Set(),
  hasStarted: false,
  runStatus: { status: "streaming" },
});

/**
 * Observe both independent Codex completion surfaces. The server-controlled
 * finish-tool result proves the protected MCP sequence; assistant text is
 * optional because a completed tool result may be the turn's final output.
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
        observation.completion = {
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
      if (observation.completion.status !== "pending") {
        observation.completion = {
          status: "failed",
          message: "canary harness returned multiple canary_finish results",
        };
        return;
      }
      const isExpectedResult =
        chunk.content === CANARY_COMPLETION_MARKER ||
        chunk.content === CANARY_FINISH_COMPLETED_RESULT;
      if (chunk.state === "output-error" || !isExpectedResult) {
        observation.completion = {
          status: "failed",
          message: "canary_finish did not return its exact completion marker",
        };
        return;
      }
      observation.completion = {
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
      const exhaustive: never = chunk;
      return exhaustive;
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
  if (observation.completion.status === "failed") {
    return observation.completion.message;
  }
  return undefined;
};

export const canaryHarnessFailure = (
  observation: CanaryHarnessObservation,
): string | undefined => {
  if (observation.runStatus.status === "failed") {
    return observation.runStatus.message;
  }
  if (observation.completion.status === "failed") {
    return observation.completion.message;
  }
  if (observation.runStatus.status !== "finished") {
    return "canary harness stream ended before RUN_FINISHED";
  }
  if (!observation.hasStarted) {
    return "canary harness stream ended without RUN_STARTED";
  }
  if (observation.completion.status !== "observed") {
    return "canary harness did not receive the completion marker from canary_finish";
  }
  const assistantText = observation.assistantText.trim();
  if (assistantText !== "" && assistantText !== CANARY_COMPLETION_MARKER) {
    return "canary harness returned unexpected assistant text";
  }
  return undefined;
};
