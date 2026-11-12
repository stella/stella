import * as v from "valibot";

import {
  CHAT_CLOUD_RUN_TARGET,
  type ChatLocalRunContext,
  chatLocalRunContextSchema,
  type ChatLocalRunTarget,
  chatLocalRunTargetSchema,
  type ChatRunTarget,
} from "@stll/api-contract/chat-run-target";

/**
 * A thread's run target as a response field: present only for a computer,
 * so cloud, the default, stays an absent field as it is in a send.
 */
export const localRunTargetField = (
  target: ChatRunTarget,
): { runTarget?: ChatLocalRunTarget } =>
  target.kind === "local" ? { runTarget: target } : {};

/**
 * The thread column's value for a run target: the local target as the
 * contract's schema shapes it, null for stella's own models.
 */
export const storedChatRunTarget = (
  target: ChatRunTarget,
): ChatLocalRunTarget | null => (target.kind === "local" ? target : null);

/**
 * The run target a thread column holds, read through the contract's schema.
 * A value the schema no longer accepts (a harness a chat turn can no longer
 * run on, say) reads as cloud: the composer then shows cloud, and a send
 * still carries its own target, so nothing is rerouted.
 */
export const chatRunTargetOf = (stored: unknown): ChatRunTarget => {
  if (stored === null) {
    return CHAT_CLOUD_RUN_TARGET;
  }
  const parsed = v.safeParse(chatLocalRunTargetSchema, stored);
  return parsed.success ? parsed.output : CHAT_CLOUD_RUN_TARGET;
};

/** Whether two run targets send turns to the same place in the same way. */
export const sameChatRunTarget = (
  left: ChatRunTarget,
  right: ChatRunTarget,
): boolean =>
  left.kind === "local"
    ? right.kind === "local" &&
      left.harness === right.harness &&
      left.model === right.model &&
      left.approvals === right.approvals &&
      left.reasoningEffort === right.reasoningEffort
    : right.kind === left.kind;

/**
 * How full the context of a thread whose turns run on the member's computer
 * is: what the harness reported after the thread's latest answer, which the
 * next turn starts from. `undefined` for a thread that runs on stella's own
 * models, or whose latest answer carries no report; the composer then shows
 * its own estimate.
 */
export const reportedLocalRunContext = ({
  target,
  messages,
}: {
  target: ChatRunTarget;
  /** The thread's messages, oldest first, with their stored metadata. */
  messages: readonly { role: string; metadata?: unknown }[];
}): ChatLocalRunContext | undefined => {
  if (target.kind !== "local") {
    return undefined;
  }
  const latest = messages.findLast(({ role }) => role === "assistant");
  const metadata: unknown = latest?.metadata;
  const parsed = v.safeParse(
    v.object({ localRunContext: chatLocalRunContextSchema }),
    metadata,
  );
  return parsed.success ? parsed.output.localRunContext : undefined;
};
