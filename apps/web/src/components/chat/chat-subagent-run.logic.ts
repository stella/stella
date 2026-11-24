import { BROWSE_WEB_TOOL_NAME } from "@stll/api-contract/browser-control";

import type { SubagentChatPart } from "@/components/chat/chat-subagent-parts.logic";
import { toSubagentChildUIPart } from "@/components/chat/chat-ui-tools";
import type {
  ChatUIMessage,
  ChatUIPart,
} from "@/components/chat/chat-ui-tools";

/** The run's title, by the sub-agent's name. */
export const subagentRunTitleKey = (
  name: string,
): "chat.subagentRun.browseWeb" | "chat.subagentRun.generic" =>
  name === BROWSE_WEB_TOOL_NAME
    ? "chat.subagentRun.browseWeb"
    : "chat.subagentRun.generic";

type ToolCallUIPart = Extract<ChatUIPart, { type: "tool-call" }>;

/**
 * Each sub-agent part of one message's parts with the call that started it,
 * when that call is among them, and the ids of those calls. The run shows the
 * call's task, so the call itself draws no step of its own.
 */
export const pairSubagentRuns = (
  parts: readonly ChatUIPart[],
): {
  callFor: (part: SubagentChatPart) => ToolCallUIPart | null;
  startingCallIds: ReadonlySet<string>;
} => {
  const calls = new Map(
    parts.flatMap((part) =>
      part.type === "tool-call" ? [[part.id, part] as const] : [],
    ),
  );
  const callFor = (part: SubagentChatPart): ToolCallUIPart | null => {
    const { parentToolCallId } = part.subagent;
    return parentToolCallId === undefined
      ? null
      : (calls.get(parentToolCallId) ?? null);
  };
  const startingCallIds = new Set(
    parts.flatMap((part) => {
      if (part.type !== "subagent") {
        return [];
      }
      const call = callFor(part);
      return call === null ? [] : [call.id];
    }),
  );
  return { callFor, startingCallIds };
};

/** The task the starting call gave the run (`{ task }`), once its input is
 *  complete enough to hold one. */
export const subagentRunTask = (call: ToolCallUIPart | null): string | null => {
  const input: unknown = call?.input;
  if (
    typeof input !== "object" ||
    input === null ||
    !("task" in input) ||
    typeof input.task !== "string"
  ) {
    return null;
  }
  const task = input.task.trim();
  return task === "" ? null : task;
};

export type SubagentRunMessage =
  | { type: "message"; message: ChatUIMessage }
  | { type: "unavailable"; id: string };

/**
 * The run's assistant messages as the thread renders a message of its own.
 * A message holding a part that fails the thread's canonical check is shown
 * as unavailable, as a top-level one is; the run's task prompt is shown from
 * the starting call instead of as a message.
 */
export const subagentRunMessages = (
  part: SubagentChatPart,
): SubagentRunMessage[] =>
  part.subagent.messages.flatMap((message): SubagentRunMessage[] => {
    if (message.role !== "assistant") {
      return [];
    }
    const parts = message.parts.map(toSubagentChildUIPart);
    if (!parts.every((child): child is ChatUIPart => child !== null)) {
      return [{ id: message.id, type: "unavailable" }];
    }
    return [
      {
        message: { id: message.id, parts, role: "assistant" },
        type: "message",
      },
    ];
  });
