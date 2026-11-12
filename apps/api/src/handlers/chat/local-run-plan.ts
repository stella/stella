import { panic, Result } from "better-result";

import {
  CHAT_LOCAL_RUN_REFUSAL,
  CHAT_RUN_TARGET_KIND,
  type ChatRunTarget,
  isApprovalModeWithin,
} from "@stll/api-contract/chat-run-target";
import {
  DESKTOP_RUNNER_FEATURE_ID,
  DESKTOP_RUNNER_LINKED_FOLDER_STATE,
  type DesktopRunnerApprovalMode,
} from "@stll/api-contract/desktop-runner";

import type { SafeDbError } from "@/api/db/safe-db";
import {
  createLocalChatRun,
  type LocalChatRun,
  type LocalRunContext,
  type LocalRunPlan,
} from "@/api/handlers/chat/local-run-chunks";
import type { SafeId } from "@/api/lib/branded-types";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import type { DesktopRunnerRunBell } from "@/api/lib/desktop-runner/doorbell";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
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
  status: 400 | 403 | 409,
  code: (typeof CHAT_LOCAL_RUN_REFUSAL)[keyof typeof CHAT_LOCAL_RUN_REFUSAL],
  message: string,
) => Result.err(new HandlerError({ status, code, message }));

/**
 * Route a turn bound for the member's computer before anything about it is
 * stored. A computer that cannot take the turn refuses it with a typed code;
 * the turn never falls back to stella's own models. A resumed turn is not
 * routed: it answers the run that paused, on whichever computer holds it.
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
  const owner = { userId, organizationId };
  const context: LocalRunContext = {
    control: runtime.control,
    runBell: runtime.runBell,
    owner,
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
  // The organization's ceiling holds whichever computer would take the turn.
  // A resumed run was held to it when it started and keeps its mode.
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
  const { folder } = runTarget;
  // A turn in a linked folder runs on the computer the folder is on.
  const picked = await runtime.control.pickDesktop({
    owner,
    harness: runTarget.harness,
    ...(folder === undefined ? {} : { desktopId: folder.desktopId }),
  });
  if (picked.isErr()) {
    return Result.err(picked.error);
  }
  const desktop = picked.value;
  switch (desktop.type) {
    case "no_computer":
      return folder === undefined
        ? refuse(
            409,
            CHAT_LOCAL_RUN_REFUSAL.noComputer,
            "None of your computers is connected.",
          )
        : refuse(
            409,
            CHAT_LOCAL_RUN_REFUSAL.folderUnavailable,
            "The computer the chat's folder is on is not connected.",
          );
    case "harness_unavailable":
      return refuse(
        409,
        CHAT_LOCAL_RUN_REFUSAL.harnessUnavailable,
        "The harness on your computer cannot take a turn right now.",
      );
    case "available": {
      if (!desktop.harness.models.some(({ id }) => id === runTarget.model)) {
        return refuse(
          409,
          CHAT_LOCAL_RUN_REFUSAL.modelUnavailable,
          "The harness on your computer does not offer that model.",
        );
      }
      if (!desktop.harness.approvalModes.includes(runTarget.approvals)) {
        return refuse(
          409,
          CHAT_LOCAL_RUN_REFUSAL.approvalsUnavailable,
          "Your computer cannot run the harness with those permissions.",
        );
      }
      if (folder !== undefined) {
        const linked = desktop.linkedFolders.find(
          ({ id }) => id === folder.linkId,
        );
        if (linked?.state !== DESKTOP_RUNNER_LINKED_FOLDER_STATE.available) {
          return refuse(
            409,
            CHAT_LOCAL_RUN_REFUSAL.folderUnavailable,
            "The chat's folder is not available on your computer.",
          );
        }
        if (!desktop.approvedFolderIds.includes(folder.linkId)) {
          return refuse(
            409,
            CHAT_LOCAL_RUN_REFUSAL.folderNotApproved,
            "Allow the agent to work in the chat's folder first.",
          );
        }
      }
      const plan: LocalRunPlan = {
        type: "start",
        destination: {
          desktopId: desktop.desktopId,
          harness: runTarget.harness,
          harnessVersion: desktop.harness.version,
          model: runTarget.model,
          approvals: runTarget.approvals,
          linkedFolderId: folder?.linkId ?? null,
        },
      };
      return Result.ok(createLocalChatRun(context, plan));
    }
    default:
      desktop satisfies never;
      return panic("Unknown computer pick");
  }
};
