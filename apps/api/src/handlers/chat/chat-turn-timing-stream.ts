import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";

import type { ChatTurnTiming } from "@/api/handlers/chat/types";
import type { ReadOutcome } from "@/api/lib/errors/read-outcome";

type WithChatTurnTimingArgs = {
  source: AsyncIterable<StreamChunk>;
  readTiming: () => Promise<ReadOutcome<ChatTurnTiming | null>>;
  getPhase: () => "running" | "settled";
};

const timingMetadata = (outcome: ReadOutcome<ChatTurnTiming | null>) => {
  switch (outcome.type) {
    case "present":
      return { turnTiming: outcome.value };
    case "unavailable":
      // The producer observes this failure. Clear any live anchor so it cannot
      // keep ticking after settlement; the message itself remains usable.
      return { turnTiming: null };
    case "absent":
    case "refused":
      return panic("Timing reads cannot establish absence or refusal");
    default:
      outcome satisfies never;
      return panic("Unhandled timing read outcome");
  }
};

/** Metadata uses the SDK's message events, so the real processor owns its
 * projection. Terminal timing is read only after durable settlement.
 * @yields Source events carrying server-owned active timing metadata.
 */
export const withChatTurnTiming = async function* ({
  source,
  readTiming,
  getPhase,
}: WithChatTurnTimingArgs): AsyncIterable<StreamChunk> {
  const running = timingMetadata(await readTiming());
  const messageIds = new Set<string>();
  let settledTiming: Promise<ReadOutcome<ChatTurnTiming | null>> | undefined;
  for await (const chunk of source) {
    if (chunk.subagentRunId !== undefined) {
      yield chunk;
      continue;
    }
    let messageId: string | undefined;
    if (
      chunk.type === EventType.TEXT_MESSAGE_START &&
      chunk.role === "assistant"
    ) {
      messageId = chunk.messageId;
    } else if (chunk.type === EventType.TOOL_CALL_START) {
      messageId = chunk.parentMessageId;
    } else if (chunk.type === EventType.REASONING_MESSAGE_START) {
      messageId = chunk.messageId;
    }
    if (messageId !== undefined) {
      if (
        !messageIds.has(messageId) &&
        chunk.type !== EventType.TEXT_MESSAGE_START
      ) {
        yield {
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: "assistant",
          timestamp: chunk.timestamp,
          metadata: running,
        };
      }
      messageIds.add(messageId);
    }
    if (
      getPhase() === "settled" &&
      (chunk.type === EventType.RUN_FINISHED ||
        chunk.type === EventType.RUN_ERROR)
    ) {
      const finished = timingMetadata(await (settledTiming ??= readTiming()));
      for (const id of messageIds) {
        yield {
          type: EventType.TEXT_MESSAGE_END,
          messageId: id,
          timestamp: chunk.timestamp,
          metadata: finished,
        };
      }
    }
    if (
      chunk.type === EventType.TEXT_MESSAGE_START &&
      chunk.role === "assistant"
    ) {
      yield { ...chunk, metadata: { ...chunk.metadata, ...running } };
      continue;
    }
    if (chunk.type === EventType.MESSAGES_SNAPSHOT) {
      yield {
        ...chunk,
        messages: chunk.messages.map((message) =>
          messageIds.has(message.id)
            ? {
                ...message,
                metadata: { ...message.metadata, ...running },
              }
            : message,
        ),
      };
      continue;
    }
    yield chunk;
  }
};
