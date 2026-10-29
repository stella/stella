import { EventType } from "@tanstack/ai";
import type { RunFinishedOutcome, StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";

const projectWithdrawnOutcome = (
  outcome: RunFinishedOutcome,
  marker: string,
): RunFinishedOutcome => {
  switch (outcome.type) {
    case "success":
      return { type: "success" };
    case "cancelled":
      return { type: "cancelled" };
    case "interrupt":
      return {
        type: "interrupt",
        interrupts: outcome.interrupts.map(
          ({ id, reason, toolCallId, subagentRunId, expiresAt }) => ({
            id,
            reason,
            message: marker,
            ...(toolCallId === undefined ? {} : { toolCallId }),
            ...(subagentRunId === undefined ? {} : { subagentRunId }),
            ...(expiresAt === undefined ? {} : { expiresAt }),
          }),
        ),
      };
    default:
      outcome satisfies never;
      return panic("Missing withdrawn run outcome projection");
  }
};

/** Project a withdrawn run without replaying tool payloads or changing durable offsets. */
export const projectWithdrawnRunChunk = (
  chunk: StreamChunk,
  marker: string,
): StreamChunk => {
  switch (chunk.type) {
    case EventType.RUN_STARTED:
      return { type: chunk.type, threadId: chunk.threadId, runId: chunk.runId };
    case EventType.RUN_FINISHED:
      return {
        type: chunk.type,
        threadId: chunk.threadId,
        runId: chunk.runId,
        ...(chunk.outcome === undefined
          ? {}
          : { outcome: projectWithdrawnOutcome(chunk.outcome, marker) }),
      };
    case EventType.RUN_ERROR:
      return { type: chunk.type, message: marker };
    case EventType.TEXT_MESSAGE_START:
      return {
        type: chunk.type,
        messageId: chunk.messageId,
        ...(chunk.role === undefined ? {} : { role: chunk.role }),
      };
    case EventType.TEXT_MESSAGE_CONTENT:
      return { type: chunk.type, messageId: chunk.messageId, delta: marker };
    case EventType.TEXT_MESSAGE_CHUNK:
      return {
        type: chunk.type,
        ...(chunk.messageId === undefined
          ? {}
          : { messageId: chunk.messageId }),
        ...(chunk.role === undefined ? {} : { role: chunk.role }),
        delta: marker,
      };
    case EventType.TEXT_MESSAGE_END:
      return { type: chunk.type, messageId: chunk.messageId };
    case EventType.MESSAGES_SNAPSHOT:
      return {
        type: chunk.type,
        messages: chunk.messages.map((message) =>
          message.role === "user"
            ? message
            : { id: message.id, role: "assistant", content: marker },
        ),
      };
    case "ACTIVITY_DELTA" satisfies StreamChunk["type"]:
    case "ACTIVITY_SNAPSHOT" satisfies StreamChunk["type"]:
    case "CUSTOM" satisfies StreamChunk["type"]:
    case "TOOL_CALL_START" satisfies StreamChunk["type"]:
    case EventType.TOOL_CALL_ARGS:
    case "TOOL_CALL_END" satisfies StreamChunk["type"]:
    case EventType.TOOL_CALL_RESULT:
    case EventType.TOOL_CALL_CHUNK:
    case EventType.STATE_SNAPSHOT:
    case EventType.STATE_DELTA:
    case EventType.RAW:
    case EventType.STEP_STARTED:
    case EventType.STEP_FINISHED:
    case EventType.REASONING_START:
    case EventType.REASONING_MESSAGE_START:
    case EventType.REASONING_MESSAGE_CONTENT:
    case EventType.REASONING_MESSAGE_END:
    case EventType.REASONING_MESSAGE_CHUNK:
    case EventType.REASONING_END:
    case EventType.REASONING_ENCRYPTED_VALUE:
    case EventType.SUBAGENT_STARTED:
    case EventType.SUBAGENT_FINISHED:
    case EventType.SUBAGENT_ERROR:
      return {
        type: EventType.CUSTOM,
        name: "withdrawn-by-publisher",
        value: marker,
      };
    default:
      chunk satisfies never;
      return panic("Missing withdrawn event projection");
  }
};
