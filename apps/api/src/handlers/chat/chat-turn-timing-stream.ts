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
 * projection. Observe at emission so provider waits count in the live duration.
 * Terminal metadata joins the final batch; the durability adapter finalizes
 * its timing in the settlement transaction before forwarding that batch.
 * @yields Source events carrying server-owned active timing metadata.
 */
export const withChatTurnTiming = async function* ({
  source,
  readTiming,
  getPhase,
}: WithChatTurnTimingArgs): AsyncIterable<StreamChunk> {
  const messageIds = new Set<string>();
  let settledTiming: Promise<ReadOutcome<ChatTurnTiming | null>> | undefined;
  const emitSettledTiming = async function* (
    timestamp?: number,
  ): AsyncIterable<StreamChunk> {
    if (settledTiming !== undefined) {
      return;
    }
    const finished = timingMetadata(await (settledTiming = readTiming()));
    for (const messageId of messageIds) {
      yield {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
        ...(timestamp === undefined ? {} : { timestamp }),
        metadata: finished,
      };
    }
  };
  for await (const chunk of source) {
    if ("subagentRunId" in chunk) {
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
          ...(chunk.timestamp === undefined
            ? {}
            : { timestamp: chunk.timestamp }),
          metadata: timingMetadata(await readTiming()),
        };
      }
      messageIds.add(messageId);
    }
    if (
      getPhase() === "settled" &&
      (chunk.type === EventType.RUN_FINISHED ||
        chunk.type === EventType.RUN_ERROR)
    ) {
      yield* emitSettledTiming(chunk.timestamp);
    }
    if (
      chunk.type === EventType.TEXT_MESSAGE_START &&
      chunk.role === "assistant"
    ) {
      const observation = timingMetadata(await readTiming());
      yield { ...chunk, metadata: { ...chunk.metadata, ...observation } };
      continue;
    }
    if (chunk.type === EventType.MESSAGES_SNAPSHOT) {
      if (!chunk.messages.some((message) => messageIds.has(message.id))) {
        yield chunk;
        continue;
      }
      const observation = timingMetadata(await readTiming());
      yield {
        ...chunk,
        messages: chunk.messages.map((message) =>
          messageIds.has(message.id)
            ? {
                ...message,
                metadata: { ...message.metadata, ...observation },
              }
            : message,
        ),
      };
      continue;
    }
    yield chunk;
  }
  if (getPhase() === "settled") {
    // Cancellation can drain the SDK source without a terminal event.
    yield* emitSettledTiming();
  }
};

type PrepareChatTurnTimingBatchArgs = {
  chunks: StreamChunk[];
  terminal: { chunk: StreamChunk; messageId: string } | undefined;
};

/** The SDK forwards the mutable append batch after persistence. Move final
 * timing into the terminal batch even when its source event filled an earlier
 * batch, so settlement can finalize it before either delivery or replay.
 */
export const prepareChatTurnTimingBatch = ({
  chunks,
  terminal,
}: PrepareChatTurnTimingBatchArgs): "pending" | "finishing" => {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks.at(index);
    if (
      chunk?.type === EventType.TEXT_MESSAGE_END &&
      chunk.metadata !== undefined &&
      "turnTiming" in chunk.metadata
    ) {
      chunks.splice(index, 1);
    }
  }
  if (terminal === undefined) {
    return "pending";
  }
  const terminalIndex = chunks.indexOf(terminal.chunk);
  if (terminalIndex === -1) {
    return "pending";
  }
  chunks.splice(terminalIndex, 0, {
    type: EventType.TEXT_MESSAGE_END,
    messageId: terminal.messageId,
    ...(terminal.chunk.timestamp === undefined
      ? {}
      : { timestamp: terminal.chunk.timestamp }),
    metadata: { turnTiming: null },
  });
  return "finishing";
};
