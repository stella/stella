import type { ChatPart } from "@/lib/api-contract";

/** A tool-mode sub-agent run as its parent message holds it
 *  (`chat({ subagents })`): the child's own messages, in order. */
export type SubagentChatPart = Extract<ChatPart, { type: "subagent" }>;
export type SubagentChildMessage =
  SubagentChatPart["subagent"]["messages"][number];
export type SubagentChildPart = SubagentChildMessage["parts"][number];

/** A part of a message, or of a sub-agent run the message holds, at any
 *  depth. A child's tool calls carry no registered tool types. */
export type ChatPartAtAnyDepth = ChatPart | SubagentChildPart;

/**
 * `parts`, each sub-agent part followed by every part its run's messages
 * hold, nested runs included, in order. A child's approval request or client
 * call waits on the user or the page exactly as a top-level one does, so
 * every check of what a turn waits on reads this instead of `parts`.
 */
export const withSubagentRunParts = (
  parts: readonly ChatPartAtAnyDepth[],
): ChatPartAtAnyDepth[] =>
  parts.flatMap((part) =>
    part.type === "subagent"
      ? [
          part,
          ...withSubagentRunParts(
            part.subagent.messages.flatMap((message) => message.parts),
          ),
        ]
      : [part],
  );

/**
 * `parts`, each suspended sub-agent part followed by every part its run's
 * messages hold, at every depth. Only a suspended run resumes with an answer,
 * so only its cards wait on the member: the same rule the API stores a
 * waiting turn by (`memberWaitsOf`).
 */
export const withWaitingSubagentRunParts = (
  parts: readonly ChatPartAtAnyDepth[],
): ChatPartAtAnyDepth[] =>
  parts.flatMap((part) =>
    part.type === "subagent" && part.subagent.status === "suspended"
      ? [
          part,
          ...withWaitingSubagentRunParts(
            part.subagent.messages.flatMap((message) => message.parts),
          ),
        ]
      : [part],
  );
