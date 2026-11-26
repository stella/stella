import * as v from "valibot";

import {
  CHAT_CLOUD_RUN_TARGET,
  chatCloudRunTarget,
  type ChatHarnessContextUsage,
  chatLocalRunContextSchema,
  type ChatLocalRunTarget,
  chatLocalRunTargetSchema,
  type ChatRunTarget,
} from "@stll/api-contract/chat-run-target";
import {
  DESKTOP_RUNNER_APPROVAL_MODES,
  DESKTOP_RUNNER_DEFAULT_APPROVAL_MODE,
  type DesktopRunnerApprovalMode,
} from "@stll/api-contract/desktop-runner";

/** A thread's two run-target columns, as a row holds them. */
export type StoredChatRunTarget = {
  /** The computer the turns run on; null runs them on stella's models. */
  chatLocalRunTarget: unknown;
  /** The permission level on stella's models; null is the default. */
  chatCloudApprovals: unknown;
};

/** The columns of a thread that has not chosen where its turns run. */
export const NO_STORED_CHAT_RUN_TARGET: StoredChatRunTarget = {
  chatLocalRunTarget: null,
  chatCloudApprovals: null,
};

/**
 * The thread columns' values for a run target: the local target as the
 * contract's schema shapes it, or stella's own models at a permission level
 * (null for the default one).
 */
export const storedChatRunTarget = (
  target: ChatRunTarget,
): {
  chatLocalRunTarget: ChatLocalRunTarget | null;
  chatCloudApprovals: DesktopRunnerApprovalMode | null;
} =>
  target.kind === "local"
    ? { chatLocalRunTarget: target, chatCloudApprovals: null }
    : {
        chatLocalRunTarget: null,
        chatCloudApprovals:
          target.approvals === DESKTOP_RUNNER_DEFAULT_APPROVAL_MODE
            ? null
            : target.approvals,
      };

const storedCloudApprovalsSchema = v.picklist(DESKTOP_RUNNER_APPROVAL_MODES);

/**
 * The run target a thread's columns hold, read through the contract's
 * schema. A local value the schema no longer accepts (a harness a chat turn
 * can no longer run on, say) reads as stella's models: the composer then
 * shows them, and a send that names no target runs there too.
 */
export const chatRunTargetOf = ({
  chatCloudApprovals,
  chatLocalRunTarget,
}: StoredChatRunTarget): ChatRunTarget => {
  if (chatLocalRunTarget !== null) {
    const parsed = v.safeParse(chatLocalRunTargetSchema, chatLocalRunTarget);
    if (parsed.success) {
      return parsed.output;
    }
  }
  const approvals = v.safeParse(storedCloudApprovalsSchema, chatCloudApprovals);
  return approvals.success
    ? chatCloudRunTarget(approvals.output)
    : CHAT_CLOUD_RUN_TARGET;
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
    : right.kind === left.kind && right.approvals === left.approvals;

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
