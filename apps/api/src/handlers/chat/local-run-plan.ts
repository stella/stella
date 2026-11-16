import { Result } from "better-result";

import {
  CHAT_LOCAL_RUN_REFUSAL,
  CHAT_RUN_TARGET_KIND,
  type ChatRunTarget,
  isApprovalModeWithin,
  isChatLocalRunHarness,
} from "@stll/api-contract/chat-run-target";
import {
  DESKTOP_RUNNER_FEATURE_ID,
  type DesktopRunnerApprovalMode,
} from "@stll/api-contract/desktop-runner";

import type { SafeDbError } from "@/api/db/safe-db";
import {
  createLocalChatRun,
  type LocalChatRun,
  type LocalRunContext,
} from "@/api/handlers/chat/local-run-chunks";
import type { SafeId } from "@/api/lib/branded-types";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import type { DesktopRunnerRunBell } from "@/api/lib/desktop-runner/doorbell";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import {
  type DatabaseError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import {
  type FeatureAccessSnapshot,
  isFeatureEnabled,
} from "@/api/lib/feature-access/policy";
import { getMcpResourceUrl } from "@/api/mcp/constants";

/** The MCP server name a local run reaches the workspace through. */
const MCP_SERVER_NAME = "stella";

export type ResolveChatLocalRunOptions = {
  runTarget: ChatRunTarget | undefined;
  /** Whether the turn also asked for the agent sandbox. */
  agentSandboxRequested: boolean;
  /** Whether the turn answers approvals of a paused run. */
  resumesPausedRun: boolean;
  featureAccessSnapshot: FeatureAccessSnapshot;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  chatThreadId: SafeId<"chatThread">;
  workspaceIds: readonly SafeId<"workspace">[];
  /**
   * The most the organization lets a run do without asking, read when the
   * turn starts so a lowered ceiling holds the next turn.
   */
  readApprovalCeiling: () => Promise<
    Result<DesktopRunnerApprovalMode, SafeDbError>
  >;
  /** The gateway control; the process's own by default. */
  runtime?: { control: DesktopRunnerControl; runBell: DesktopRunnerRunBell };
};

/**
 * The chat thread of the member's run that is still going, for what the run's
 * own token may write: the run's row names the thread, never the request.
 */
export const readOpenLocalRunThread = async (
  options: Parameters<DesktopRunnerControl["readOpenRunChatThread"]>[0],
  runtime: Pick<
    ReturnType<typeof getDesktopRunnerControl>,
    "control"
  > = getDesktopRunnerControl(),
) => await runtime.control.readOpenRunChatThread(options);

const refuse = (
  status: 400 | 403,
  code: (typeof CHAT_LOCAL_RUN_REFUSAL)[keyof typeof CHAT_LOCAL_RUN_REFUSAL],
  message: string,
) => Result.err(new HandlerError({ status, code, message }));

/**
 * Check that a turn bound for the member's computer may be asked for at all,
 * before anything about it is stored: the request does not also ask for the
 * agent sandbox, local runs are enabled for the member, and the approval mode
 * is within the organization's ceiling. These depend on the request and the
 * member alone, so a refusal here repeats however often it is sent.
 *
 * Which computer takes the turn is decided once the turn is stored, as its
 * run starts (`routeLocalRun`): a computer that cannot take it ends the turn
 * as a failed turn the member reads on every client. The turn never falls
 * back to stella's own models. A resumed turn answers the run that paused, on
 * whichever computer holds it.
 */
export const resolveChatLocalRun = async ({
  runTarget,
  agentSandboxRequested,
  resumesPausedRun,
  featureAccessSnapshot,
  userId,
  organizationId,
  chatThreadId,
  workspaceIds,
  readApprovalCeiling,
  runtime = getDesktopRunnerControl(),
}: ResolveChatLocalRunOptions): Promise<
  Result<LocalChatRun | undefined, HandlerError | SafeDbError>
> => {
  if (
    runTarget === undefined ||
    runTarget.kind === CHAT_RUN_TARGET_KIND.cloud
  ) {
    return Result.ok(undefined);
  }
  if (agentSandboxRequested) {
    return refuse(
      400,
      CHAT_LOCAL_RUN_REFUSAL.conflictingRunMode,
      "A turn runs either in the agent sandbox or on a computer, not both.",
    );
  }
  if (
    !isFeatureEnabled(featureAccessSnapshot, DESKTOP_RUNNER_FEATURE_ID, {
      organizationId,
      userId,
    })
  ) {
    return refuse(
      403,
      CHAT_LOCAL_RUN_REFUSAL.unavailable,
      "Running chat turns on a computer is not available.",
    );
  }
  const context: LocalRunContext = {
    control: runtime.control,
    runBell: runtime.runBell,
    owner: { userId, organizationId },
    chatThreadId,
    workspaceIds,
    mcp: { serverName: MCP_SERVER_NAME, url: getMcpResourceUrl() },
  };
  if (resumesPausedRun) {
    return Result.ok(
      createLocalChatRun(context, {
        type: "resume",
        harness: runTarget.harness,
      }),
    );
  }
  // The organization's ceiling holds whichever computer takes the turn. A
  // resumed run was held to it when it started and keeps its mode.
  const ceiling = await readApprovalCeiling();
  if (ceiling.isErr()) {
    return Result.err(ceiling.error);
  }
  if (!isApprovalModeWithin(runTarget.approvals, ceiling.value)) {
    return refuse(
      403,
      CHAT_LOCAL_RUN_REFUSAL.approvalsAboveLimit,
      "Your organization does not let a run on your computer do that much without asking.",
    );
  }
  return Result.ok(
    createLocalChatRun(context, { type: "start", target: runTarget }),
  );
};

/** The run a handed-over turn reads on, or why the adopter cannot read it. */
type AdoptedChatLocalRun =
  | { type: "adopted"; run: LocalChatRun }
  /** The turn has no chat run on a computer for this member. */
  | { type: "no-run" }
  /** The member may no longer run turns on a computer. */
  | { type: "unavailable" };

/**
 * The run of a handed-over turn, read on by the task that adopted it: the
 * member may still run turns on a computer (a member who lost that is
 * refused, and the turn ends at its lease), and the run goes on with the
 * matters the thread reaches now. The approval ceiling was held when the run
 * started, as for a resumed run.
 */
export const adoptChatLocalRun = async ({
  chatThreadId,
  chatTurnId,
  featureAccessSnapshot,
  organizationId,
  runtime = getDesktopRunnerControl(),
  userId,
  workspaceIds,
}: Pick<
  ResolveChatLocalRunOptions,
  | "chatThreadId"
  | "featureAccessSnapshot"
  | "organizationId"
  | "runtime"
  | "userId"
  | "workspaceIds"
> & {
  chatTurnId: SafeId<"chatTurn">;
}): Promise<Result<AdoptedChatLocalRun, DatabaseError>> => {
  if (
    !isFeatureEnabled(featureAccessSnapshot, DESKTOP_RUNNER_FEATURE_ID, {
      organizationId,
      userId,
    })
  ) {
    return Result.ok({ type: "unavailable" });
  }
  const owner = { userId, organizationId };
  const found = await runtime.control.readHandedOverChatRun({
    owner,
    chat: { threadId: chatThreadId, turnId: chatTurnId },
  });
  if (found.isErr()) {
    return Result.err(found.error);
  }
  const run = found.value;
  if (run === null || !isChatLocalRunHarness(run.harness)) {
    return Result.ok({ type: "no-run" });
  }
  return Result.ok({
    type: "adopted",
    run: createLocalChatRun(
      {
        control: runtime.control,
        runBell: runtime.runBell,
        owner,
        chatThreadId,
        workspaceIds,
        mcp: { serverName: MCP_SERVER_NAME, url: getMcpResourceUrl() },
      },
      { type: "adopt", harness: run.harness },
    ),
  });
};
