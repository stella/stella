import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import type { UIMessage } from "@tanstack/ai-client";

import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import type { OracleViolation } from "@/api/tests/helpers/chat-oracles";
import type { OfferedInteraction } from "@/api/tests/helpers/chat-thread-invariants";

// Live/reload invariants: what the browser shows while a turn streams must be
// what it shows after a reload. The persisted-thread invariants check the
// stored thread alone; a fault that loses state only in the browser (a
// snapshot the client folds wrongly, a card that never mounts) leaves the
// stored thread sound, so these compare the client's two views of it, and the
// wire the live view was built from.

type UIPart = UIMessage["parts"][number];
type ToolCallUIPart = Extract<UIPart, { type: "tool-call" }>;

/** A tool call as the user sees it: its card, state, decision, input and
 *  output. */
type ToolCallView = {
  approval: { approved: boolean | null; id: string } | null;
  id: string;
  input: string | null;
  name: string;
  output: string | null;
  state: ToolCallUIPart["state"];
};

/**
 * A message as the live/reload comparison sees it.
 *
 * The one normalization, TEXT_BEFORE_TOOL_CARDS: a message's text and its tool
 * calls are compared as two sequences rather than one interleaved part list,
 * and the text sequence as its content joined by a blank line. One AG-UI
 * assistant message in an interrupt snapshot carries a single `content`
 * string and a single `toolCalls` array, so after an interrupt the live view
 * shows the turn's text, joined, ahead of its tool cards, while a reload
 * interleaves them in the order the model produced them.
 *
 * It drops only the interleaving: the order of the text segments, the order
 * of the tool calls (and so the order the user acts on them), each call's
 * input, output, state and decision, the tool results and the message each
 * reasoning block belongs to are all compared as they are. Tool input and
 * output are compared as JSON values, since Postgres `jsonb` does not keep
 * object key order.
 */
type MessageView = {
  id: string;
  reasoning: string[];
  role: UIMessage["role"];
  text: string;
  toolCalls: ToolCallView[];
  toolResults: { error: string | null; state: string; toolCallId: string }[];
};

export const TEXT_SEGMENT_SEPARATOR = "\n\n";

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : 1))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
};

const jsonValue = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(sortKeys(value));

const toolCallView = (part: ToolCallUIPart): ToolCallView => ({
  approval:
    part.approval === undefined
      ? null
      : { approved: part.approval.approved ?? null, id: part.approval.id },
  id: part.id,
  input: jsonValue(part.input),
  name: part.name,
  output: jsonValue(part.output),
  state: part.state,
});

const messageView = (message: UIMessage): MessageView => {
  const text: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: ToolCallView[] = [];
  const toolResults: MessageView["toolResults"] = [];
  for (const part of message.parts) {
    switch (part.type) {
      case "text": {
        if (part.content.length > 0) {
          text.push(part.content);
        }
        break;
      }
      case "thinking": {
        reasoning.push(part.content);
        break;
      }
      case "tool-call": {
        toolCalls.push(toolCallView(part));
        break;
      }
      case "tool-result": {
        toolResults.push({
          error: part.error ?? null,
          state: part.state,
          toolCallId: part.toolCallId,
        });
        break;
      }
      case "audio":
      case "document":
      case "image":
      case "structured-output":
      case "ui-resource":
      case "video": {
        // Attachments and rich parts round-trip as stored parts; the chat
        // flows these invariants drive do not produce them.
        break;
      }
    }
  }
  return {
    id: message.id,
    reasoning,
    role: message.role,
    text: text.join(TEXT_SEGMENT_SEPARATOR),
    toolCalls,
    toolResults,
  };
};

const duplicatesOf = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
};

/**
 * `chat.wire.snapshot-identity`: each messages snapshot a response carries
 * holds every message id once and every tool call and tool result once,
 * checked on the chunks before a client folds them into its list.
 */
export const findWireIdentityViolations = (
  chunks: readonly StreamChunk[],
): OracleViolation[] =>
  violationsOf(
    CHAT_ORACLE.wireSnapshotIdentity,
    chunks.flatMap((chunk, index) => {
      if (chunk.type !== EventType.MESSAGES_SNAPSHOT) {
        return [];
      }
      const messageIds = duplicatesOf(chunk.messages.map(({ id }) => id));
      const toolCallIds = duplicatesOf(
        chunk.messages.flatMap((message) =>
          message.role === "assistant"
            ? (message.toolCalls ?? []).map(({ id }) => id)
            : [],
        ),
      );
      const toolResultIds = duplicatesOf(
        chunk.messages.flatMap((message) =>
          message.role === "tool" ? [message.toolCallId] : [],
        ),
      );
      return messageIds.length + toolCallIds.length + toolResultIds.length === 0
        ? []
        : [{ chunk: index, messageIds, toolCallIds, toolResultIds }];
    }),
  );

/** The calls `parts` hold a result for: a tool-result part, or an output on
 *  the call. */
const resultIdsOf = (parts: readonly unknown[]): string[] =>
  parts.flatMap((part) => {
    if (typeof part !== "object" || part === null) {
      return [];
    }
    const type: unknown = Reflect.get(part, "type");
    const id: unknown = Reflect.get(
      part,
      type === "tool-result" ? "toolCallId" : "id",
    );
    const carriesResult =
      type === "tool-result" ||
      (type === "tool-call" && Reflect.get(part, "output") !== undefined);
    return carriesResult && typeof id === "string" ? [id] : [];
  });

type SnapshotMessage = Extract<
  StreamChunk,
  { type: EventType.MESSAGES_SNAPSHOT }
>["messages"][number];

/** The calls a snapshot message carries a result for: a tool message, or a
 *  message in UI form, whose `parts` the client takes as they are. */
const snapshotResultIds = (message: SnapshotMessage): string[] => {
  if (message.role === "tool") {
    return [message.toolCallId];
  }
  const parts: unknown = Reflect.get(message, "parts");
  return Array.isArray(parts) ? resultIdsOf(parts) : [];
};

/**
 * `chat.wire.results-stored`: every tool result a messages snapshot carries is
 * one the stored thread holds once the response is done. A result only the
 * engine was handed (the error that closes, for the model, a call an ended
 * turn left open) must never reach a client.
 */
export const findUnstoredWireResults = ({
  chunks,
  stored,
}: {
  chunks: readonly StreamChunk[];
  stored: readonly UIMessage[];
}): OracleViolation[] => {
  const storedResults = new Set(
    stored.flatMap(({ parts }) => resultIdsOf(parts)),
  );
  return violationsOf(
    CHAT_ORACLE.wireResultsStored,
    chunks.flatMap((chunk, index) => {
      if (chunk.type !== EventType.MESSAGES_SNAPSHOT) {
        return [];
      }
      const unstored = chunk.messages
        .flatMap(snapshotResultIds)
        .filter((toolCallId) => !storedResults.has(toolCallId));
      return unstored.length === 0 ? [] : [{ chunk: index, unstored }];
    }),
  );
};

/** An interrupt the page received with its latest response. */
export type DeliveredInterrupt = {
  interruptId: string;
  /** Null when the interrupt carries no tool binding. */
  toolCallId: string | null;
};

/**
 * `chat.live.interactions-actionable`: every interaction the stored thread
 * offers is on screen in the live view, on the message that owns it, in the
 * state the stored thread holds, with no decision or output recorded yet.
 * When the page holds interrupts from its latest response, the interaction is
 * among them too, because that is what the card's answer resolves. Otherwise
 * the card never mounts, or mounts and cannot answer, and nothing (neither
 * the user nor an automatic approval) can act on it until a reload.
 */
const findUnmountedInteractions = ({
  delivered,
  live,
  offered,
}: {
  /** Null when the page has received no interrupt since it loaded. */
  delivered: readonly DeliveredInterrupt[] | null;
  live: readonly UIMessage[];
  offered: readonly OfferedInteraction[];
}): OracleViolation[] =>
  violationsOf(
    CHAT_ORACLE.liveInteractionsActionable,
    offered.flatMap((interaction): unknown[] => {
      const part = live
        .findLast(({ id }) => id === interaction.messageId)
        ?.parts.find(
          (candidate): candidate is ToolCallUIPart =>
            candidate.type === "tool-call" &&
            candidate.id === interaction.toolCallId,
        );
      if (part === undefined || part.state !== interaction.state) {
        return [{ interaction, live: part ?? null, reason: "not on screen" }];
      }
      const answered =
        interaction.kind === "approval"
          ? part.approval === undefined || part.approval.approved !== undefined
          : part.output !== undefined;
      if (answered) {
        return [{ interaction, live: part, reason: "already answered" }];
      }
      if (
        delivered !== null &&
        delivered.length > 0 &&
        !delivered.some(
          ({ toolCallId }) => toolCallId === interaction.toolCallId,
        )
      ) {
        return [{ delivered, interaction, reason: "no interrupt to resolve" }];
      }
      return [];
    }),
  );

/**
 * `chat.live.equals-reload`: the live view equals the reload view message for
 * message, under the one normalization `MessageView` documents.
 */
export const diffLiveAgainstReload = ({
  live,
  reload,
}: {
  live: readonly UIMessage[];
  reload: readonly UIMessage[];
}): OracleViolation[] => {
  const differences: unknown[] = [];
  const length = Math.max(live.length, reload.length);
  for (let index = 0; index < length; index += 1) {
    const liveMessage = live.at(index);
    const reloadMessage = reload.at(index);
    const liveView =
      liveMessage === undefined ? null : messageView(liveMessage);
    const reloadView =
      reloadMessage === undefined ? null : messageView(reloadMessage);
    if (JSON.stringify(liveView) !== JSON.stringify(reloadView)) {
      differences.push({ index, live: liveView, reload: reloadView });
    }
  }
  return violationsOf(CHAT_ORACLE.liveEqualsReload, differences);
};

const countToolParts = (messages: readonly UIMessage[]) => {
  const counts = new Map<string, number>();
  for (const part of messages.flatMap(({ parts }) => parts)) {
    if (part.type === "tool-call") {
      const key = `tool-call:${part.id}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } else if (part.type === "tool-result") {
      const key = `tool-result:${part.toolCallId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
};

/**
 * `chat.live.tool-parts-once`: every tool call and every tool result either
 * view holds appears exactly once in the live view, and the reload view holds
 * it exactly once too.
 */
const findMiscountedToolParts = ({
  live,
  reload,
}: {
  live: readonly UIMessage[];
  reload: readonly UIMessage[];
}): OracleViolation[] => {
  const liveCounts = countToolParts(live);
  const reloadCounts = countToolParts(reload);
  const keys = new Set([...liveCounts.keys(), ...reloadCounts.keys()]);
  return violationsOf(
    CHAT_ORACLE.liveToolPartsOnce,
    [...keys].flatMap((key) => {
      const liveCount = liveCounts.get(key) ?? 0;
      const reloadCount = reloadCounts.get(key) ?? 0;
      return liveCount === 1 && reloadCount === 1
        ? []
        : [{ key, live: liveCount, reload: reloadCount }];
    }),
  );
};

/**
 * Every live/reload invariant for one page: (a) unique message ids, (b)
 * actionable interactions, (c) live equals reload, (d) tool parts once.
 */
export const findLiveViewViolations = ({
  delivered,
  live,
  offered,
  reload,
}: {
  delivered: readonly DeliveredInterrupt[] | null;
  live: readonly UIMessage[];
  offered: readonly OfferedInteraction[];
  reload: readonly UIMessage[];
}): OracleViolation[] => [
  ...violationsOf(
    CHAT_ORACLE.liveMessageIdsUnique,
    duplicatesOf(live.map(({ id }) => id)),
  ),
  ...findUnmountedInteractions({ delivered, live, offered }),
  ...diffLiveAgainstReload({ live, reload }),
  ...findMiscountedToolParts({ live, reload }),
];
