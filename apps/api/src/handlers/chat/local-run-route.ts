import { panic, Result } from "better-result";

import type {
  ChatLocalRunHarness,
  ChatRunTarget,
} from "@stll/api-contract/chat-run-target";
import {
  DESKTOP_RUNNER_LINKED_FOLDER_STATE,
  type DesktopRunnerApprovalMode,
  type DesktopRunnerHarnessReport,
  type DesktopRunnerReasoningEffort,
} from "@stll/api-contract/desktop-runner";

import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import type { RunOwner } from "@/api/lib/desktop-runner/store";
import type { DatabaseError } from "@/api/lib/errors/tagged-errors";

/** What the member asked a new turn to run on, as the send carried it. */
export type LocalRunTarget = Extract<ChatRunTarget, { kind: "local" }>;

/** The computer and harness a new turn runs on, picked as its run starts. */
export type LocalRunDestination = {
  desktopId: string;
  harness: ChatLocalRunHarness;
  harnessVersion: string;
  model: string;
  reasoningEffort: DesktopRunnerReasoningEffort | null;
  approvals: DesktopRunnerApprovalMode;
  /** The folder linked on that computer the run works in, if any. */
  linkedFolderId: string | null;
};

/**
 * Why no computer of the member can take the turn as asked. The turn is
 * stored by now, so each of these ends it as a failed turn the member reads
 * on every client, never as a refused request.
 */
export type LocalRunRouteRefusal =
  /** None of the member's computers is connected. */
  | { type: "no_computer" }
  /** The harness is not ready on the computer; `report` says why, if known. */
  | { type: "harness_unavailable"; report: DesktopRunnerHarnessReport | null }
  | { type: "model_unavailable" }
  | { type: "reasoning_effort_unavailable" }
  | { type: "approvals_unavailable" }
  /** The chat's folder: its computer is away, or reports it not available. */
  | { type: "folder_unavailable" }
  /** The member has not yet let runs work in the chat's folder. */
  | { type: "folder_not_approved" };

export type LocalRunRoute =
  { type: "routed"; destination: LocalRunDestination } | LocalRunRouteRefusal;

type RouteLocalRunOptions = {
  control: Pick<DesktopRunnerControl, "pickDesktop">;
  owner: RunOwner;
  target: LocalRunTarget;
};

/**
 * Pick the computer a new turn runs on, from what the member's computers
 * report now. A turn in a linked folder runs on the computer the folder is
 * on. The run's insert checks the same facts again under the capacity lock,
 * so this decides the reason the member reads, not whether the run may start.
 */
export const routeLocalRun = async ({
  control,
  owner,
  target,
}: RouteLocalRunOptions): Promise<Result<LocalRunRoute, DatabaseError>> => {
  const { folder } = target;
  const picked = await control.pickDesktop({
    owner,
    harness: target.harness,
    ...(folder === undefined ? {} : { desktopId: folder.desktopId }),
  });
  if (picked.isErr()) {
    return Result.err(picked.error);
  }
  const desktop = picked.value;
  switch (desktop.type) {
    case "no_computer":
      return Result.ok(
        folder === undefined
          ? { type: "no_computer" }
          : { type: "folder_unavailable" },
      );
    case "harness_unavailable":
      return Result.ok({
        type: "harness_unavailable",
        report: desktop.report,
      });
    case "available": {
      const model = desktop.harness.models.find(
        ({ id }) => id === target.model,
      );
      if (model === undefined) {
        return Result.ok({ type: "model_unavailable" });
      }
      if (
        target.reasoningEffort !== null &&
        !model.reasoningEfforts.includes(target.reasoningEffort)
      ) {
        return Result.ok({ type: "reasoning_effort_unavailable" });
      }
      if (!desktop.harness.approvalModes.includes(target.approvals)) {
        return Result.ok({ type: "approvals_unavailable" });
      }
      if (folder !== undefined) {
        const linked = desktop.linkedFolders.find(
          ({ id }) => id === folder.linkId,
        );
        if (linked?.state !== DESKTOP_RUNNER_LINKED_FOLDER_STATE.available) {
          return Result.ok({ type: "folder_unavailable" });
        }
        if (!desktop.approvedFolderIds.includes(folder.linkId)) {
          return Result.ok({ type: "folder_not_approved" });
        }
      }
      return Result.ok({
        type: "routed",
        destination: {
          desktopId: desktop.desktopId,
          harness: target.harness,
          harnessVersion: desktop.harness.version,
          model: target.model,
          reasoningEffort: target.reasoningEffort,
          approvals: target.approvals,
          linkedFolderId: folder?.linkId ?? null,
        },
      });
    }
    default:
      desktop satisfies never;
      return panic("Unknown computer pick");
  }
};
