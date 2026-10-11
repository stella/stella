import { EventType } from "@tanstack/ai";
import type { StreamChunk, StreamDurability } from "@tanstack/ai";
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
    const finished =
      getPhase() === "settled"
        ? timingMetadata(await (settledTiming = readTiming()))
        : { turnTiming: null };
    for (const messageId of messageIds) {
      yield {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
        ...(timestamp === undefined ? {} : { timestamp }),
        metadata: finished,
      };
    }
  };
  try {
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
  } catch (error) {
    // Clear the live anchor before the SDK flushes its buffered events and
    // records the source failure. Rethrow so the transport reports that error.
    yield* emitSettledTiming();
    throw error;
  }
  yield* emitSettledTiming();
};

type PrepareChatTurnTimingBatchArgs = {
  chunks: StreamChunk[];
  terminal: { chunk: StreamChunk; messageId: string } | undefined;
  settlement: "pending" | "ready";
};

/** The SDK forwards the mutable append batch after persistence. Move final
 * timing into the terminal batch even when its source event filled an earlier
 * batch, so settlement can finalize it before either delivery or replay.
 */
const prepareChatTurnTimingBatch = ({
  chunks,
  terminal,
  settlement,
}: PrepareChatTurnTimingBatchArgs): "pending" | "finishing" => {
  if (terminal === undefined) {
    const hasFinalTiming = chunks.some(
      (chunk) =>
        chunk.type === EventType.TEXT_MESSAGE_END &&
        chunk.metadata !== undefined &&
        "turnTiming" in chunk.metadata,
    );
    return settlement === "ready" && hasFinalTiming ? "finishing" : "pending";
  }
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

type CreateChatTurnTimingDurabilityArgs = {
  log: StreamDurability;
  getTerminal: () => PrepareChatTurnTimingBatchArgs["terminal"];
  getPhase: () => "running" | "settled";
  finishSettlement: () => Promise<void>;
  readTiming: WithChatTurnTimingArgs["readTiming"];
};

/** Every producer exit persists final timing while still fenced, settles the
 * turn, and then releases delivery. Source failures clear the live anchor
 * before the SDK records its error and enters this same finalization point.
 */
export const createChatTurnTimingDurability = ({
  log,
  getTerminal,
  getPhase,
  finishSettlement,
  readTiming,
}: CreateChatTurnTimingDurabilityArgs): StreamDurability => {
  let status: "pending" | "finished" = "pending";
  let messageId: string | undefined;
  let settlement: Promise<void> | undefined;
  const settle = async () => {
    settlement ??= finishSettlement();
    await settlement;
  };
  const finalize = async (chunks: StreamChunk[]) => {
    const offsets = await log.append(chunks);
    await settle();
    const timing = timingMetadata(await readTiming());
    for (const chunk of chunks) {
      if (
        chunk.type === EventType.TEXT_MESSAGE_END &&
        chunk.metadata !== undefined &&
        "turnTiming" in chunk.metadata
      ) {
        chunk.metadata["turnTiming"] = timing.turnTiming;
      }
    }
    status = "finished";
    return offsets;
  };
  return {
    ...log,
    append: async (chunks) => {
      for (const chunk of chunks) {
        if (
          chunk.type === EventType.TEXT_MESSAGE_START &&
          chunk.role === "assistant"
        ) {
          messageId = chunk.messageId;
        }
      }
      const last = chunks.at(-1);
      const terminal =
        getTerminal() ??
        (getPhase() === "running" &&
        last?.type === EventType.RUN_ERROR &&
        messageId !== undefined
          ? { chunk: last, messageId }
          : undefined);
      const phase = prepareChatTurnTimingBatch({
        chunks,
        terminal,
        settlement: getPhase() === "settled" ? "ready" : "pending",
      });
      return phase === "finishing"
        ? await finalize(chunks)
        : await log.append(chunks);
    },
    close: async () => {
      try {
        if (status === "pending" && messageId !== undefined) {
          await finalize([
            {
              type: EventType.TEXT_MESSAGE_END,
              messageId,
              metadata: { turnTiming: null },
            },
          ]);
        }
      } finally {
        // A failed cleanup append must still release the producing run.
        await settle();
        await log.close();
      }
    },
  };
};
