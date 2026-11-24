import * as v from "valibot";

import {
  CHAT_CLOUD_RUN_TARGET,
  type ChatHarnessContextUsage,
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
 * run on, say) reads as cloud: the composer then shows cloud, and a send that
 * names no target runs there too.
 */
export const chatRunTargetOf = (stored: unknown): ChatRunTarget => {
  if (stored === null) {
    return CHAT_CLOUD_RUN_TARGET;
  }
  const parsed = v.safeParse(chatLocalRunTargetSchema, stored);
  return parsed.success ? parsed.output : CHAT_CLOUD_RUN_TARGET;
};

/**
 * Where a turn runs: the target its send names, otherwise where its thread
 * runs, so every client that leaves the target out (the phone, a queued
 * message, a script) gets the thread's computer rather than stella's models.
 * A send that asks for the agent sandbox has named where it runs, which is
 * never the thread's computer.
 */
export const turnRunTarget = ({
  agentSandboxRequested,
  requested,
  thread,
}: {
  agentSandboxRequested: boolean;
  requested: ChatRunTarget | undefined;
  /** The thread's stored target; cloud for a thread the send creates. */
  thread: ChatRunTarget;
}): ChatRunTarget => {
  if (requested !== undefined) {
    return requested;
  }
  return agentSandboxRequested ? CHAT_CLOUD_RUN_TARGET : thread;
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
      left.folder?.desktopId === right.folder?.desktopId &&
      left.folder?.linkId === right.folder?.linkId &&
      left.reasoningEffort === right.reasoningEffort
    : right.kind === left.kind;

/**
 * The context meter of a thread whose turns run on the member's computer:
 * what its harness reported after the thread's latest answer, which the next
 * turn starts from, or `reported: null` while that answer carries no report.
 * `undefined` for a thread that runs on stella's own models, whose meter is
 * stella's estimate. A thread on a computer never gets the estimate: it
 * measures stella's cloud prompt and tools against a cloud model's window,
 * not the context the harness builds.
 */
export const localRunContextUsage = ({
  target,
  messages,
}: {
  target: ChatRunTarget;
  /** The thread's messages, oldest first, with their stored metadata. */
  messages: readonly { role: string; metadata?: unknown }[];
}): ChatHarnessContextUsage | undefined => {
  if (target.kind !== "local") {
    return undefined;
  }
  const latest = messages.findLast(({ role }) => role === "assistant");
  const metadata: unknown = latest?.metadata;
  const parsed = v.safeParse(
    v.object({ localRunContext: chatLocalRunContextSchema }),
    metadata,
  );
  return {
    source: "harness",
    reported: parsed.success ? parsed.output.localRunContext : null,
  };
};
