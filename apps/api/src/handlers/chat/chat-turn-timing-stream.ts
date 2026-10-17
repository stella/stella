import { EventType } from "@tanstack/ai";
import type { StreamChunk, StreamDurability } from "@tanstack/ai";
import { panic, Result } from "better-result";

import { Temporal } from "@stll/time";

import type { ChatTurnTiming } from "@/api/handlers/chat/types";
import { classifyAIError } from "@/api/lib/ai-error";
import type { ReadOutcome } from "@/api/lib/errors/read-outcome";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const SOURCE_FAILED_SINK = failureSink({
  event: "chat.turn.timing_source_failed",
  expected: [],
});

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
  let assistantMessageId: string | undefined;
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
    const messageId = assistantMessageId;
    if (messageId === undefined) {
      return;
    }
    // The single assistant message has one fenced final timing event.
    yield {
      type: EventType.TEXT_MESSAGE_END,
      messageId,
      ...(timestamp === undefined ? {} : { timestamp }),
      metadata: finished,
    };
  };
  const iterator = source[Symbol.asyncIterator]();
  let sourceState: "reading" | "ended" = "reading";
  try {
    while (true) {
      const step = await Result.tryPromise(async () => await iterator.next());
      if (Result.isError(step)) {
        sourceState = "ended";
        observeFailure(step.error.cause, { sink: SOURCE_FAILED_SINK });
        if (getPhase() === "settled") {
          // Settlement is final; the SDK must not append a new error after
          // the execution fence has been released.
          return;
        }
        // SDK cleanup appends thrown errors without forwarding that batch.
        // Emit the terminal error here so durability can settle its timing
        // while fenced and forward both events to the live reader.
        const kind = classifyAIError(step.error.cause);
        yield {
          type: EventType.RUN_ERROR,
          timestamp: Temporal.Now.instant().epochMilliseconds,
          message: kind,
          code: kind,
          error: { message: kind, code: kind },
        };
        return;
      }
      if (step.value.done) {
        sourceState = "ended";
        break;
      }
      const chunk = step.value.value;
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
          assistantMessageId !== undefined &&
          assistantMessageId !== messageId
        ) {
          panic("Chat turn timing supports one assistant message");
        }
        if (
          assistantMessageId === undefined &&
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
        assistantMessageId = messageId;
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
        const trackedMessageId = assistantMessageId;
        if (
          !chunk.messages.some((message) => message.id === trackedMessageId)
        ) {
          yield chunk;
          continue;
        }
        const observation = timingMetadata(await readTiming());
        yield {
          ...chunk,
          messages: chunk.messages.map((message) =>
            message.id === trackedMessageId
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
    yield* emitSettledTiming();
  } finally {
    if (sourceState === "reading") {
      await iterator.return?.();
    }
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
const prepareChatTurnTimingBatch = ({
  chunks,
  terminal,
}: PrepareChatTurnTimingBatchArgs): "pending" | "finishing" => {
  if (terminal === undefined) {
    const hasFinalTiming = chunks.some(
      (chunk) =>
        chunk.type === EventType.TEXT_MESSAGE_END &&
        chunk.metadata !== undefined &&
        "turnTiming" in chunk.metadata,
    );
    return hasFinalTiming ? "finishing" : "pending";
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
 * turn, and then releases delivery. The final timing event emitted on source
 * failure or exhaustion is finalized before the SDK forwards its batch.
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
      if (status === "finished") {
        return await log.append(chunks);
      }
      for (const chunk of chunks) {
        if (
          chunk.type === EventType.TEXT_MESSAGE_START &&
          chunk.role === "assistant"
        ) {
          if (messageId !== undefined && messageId !== chunk.messageId) {
            panic("Chat turn timing supports one assistant message");
          }
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
