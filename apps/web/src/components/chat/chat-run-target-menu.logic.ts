import { panic } from "better-result";

import {
  approvalModeWithin,
  CHAT_CLOUD_RUN_TARGET,
  CHAT_LOCAL_RUN_DEFAULT_MAX_APPROVALS,
  CHAT_LOCAL_RUN_HARNESSES,
  CHAT_RUN_TARGET_KIND,
  type ChatLocalFolderApproval,
  type ChatLocalHarnessReadiness,
  type ChatLocalRunFolder,
  type ChatLocalRunHarness,
  type ChatLocalRunReadiness,
  type ChatLocalRunTarget,
  type ChatRunTarget,
  isApprovalModeWithin,
} from "@stll/api-contract/chat-run-target";
import {
  DESKTOP_RUNNER_APPROVAL_MODES,
  DESKTOP_RUNNER_DEFAULT_APPROVAL_MODE,
  DESKTOP_RUNNER_LINKED_FOLDER_STATE,
  type DesktopRunnerApprovalMode,
  type DesktopRunnerLinkedFolderState,
  type DesktopRunnerReasoningEffort,
} from "@stll/api-contract/desktop-runner";

import type { TranslationKey } from "@/i18n/types";

/** Each permission mode's name and what it lets a run do on its own. */
export const LOCAL_RUN_PERMISSION_KEYS = {
  ask: {
    label: "common.ask",
    description: "chat.localRun.permissionAskDescription",
  },
  auto: {
    label: "chat.modelSelector.autoLabel",
    description: "chat.localRun.permissionAutoDescription",
  },
  full_auto: {
    label: "chat.localRun.permissionFullAuto",
    description: "chat.localRun.permissionFullAutoDescription",
  },
} as const satisfies Record<
  DesktopRunnerApprovalMode,
  { label: TranslationKey; description: TranslationKey }
>;

/** Product names of the harnesses, shown as they are in every locale. */
export const CHAT_LOCAL_HARNESS_NAMES = {
  codex: "Codex",
  "claude-code": "Claude Code",
} as const satisfies Record<ChatLocalRunHarness, string>;

type HarnessState = ChatLocalHarnessReadiness["state"];
type ReadyHarnessReport = Extract<
  ChatLocalHarnessReadiness,
  { state: "ready" }
>;
type HarnessModels = ReadyHarnessReport["models"];

/**
 * One harness as the Run on menu offers it: ready with its models, or why it
 * cannot take a turn right now. `offline` means no computer of the member is
 * connected, whatever it reported before.
 */
export type ChatLocalHarnessOption =
  | {
      harness: ChatLocalRunHarness;
      state: "ready";
      /** As the harness reports them: `isDefault` marks the one it runs
       *  when none is named, and each lists the efforts a turn may ask for. */
      models: HarnessModels;
      /** The permission modes the computer can run the harness in. */
      approvalModes: readonly DesktopRunnerApprovalMode[];
    }
  | { harness: ChatLocalRunHarness; state: "limit_until"; resetsAt: string }
  | {
      harness: ChatLocalRunHarness;
      state: Exclude<HarnessState, "ready" | "limit_until"> | "offline";
    };

const optionOf = (
  harness: ChatLocalRunHarness,
  report: ChatLocalHarnessReadiness | undefined,
): ChatLocalHarnessOption => {
  if (report === undefined) {
    return { harness, state: "not_installed" };
  }
  switch (report.state) {
    case "ready":
      return {
        harness,
        state: "ready",
        models: report.models,
        approvalModes: report.approvalModes,
      };
    case "limit_until":
      return { harness, state: "limit_until", resetsAt: report.resetsAt };
    case "needs_login":
    case "not_installed":
    case "unsupported":
    case "unavailable":
      return { harness, state: report.state };
    default:
      report satisfies never;
      return panic("Unknown harness state");
  }
};

/**
 * What the Run on menu offers for each harness, or `null` when the member
 * cannot run turns on a computer and the menu shows no Run on choice. A ready
 * report on any connected computer wins, as the API routes a turn to it;
 * otherwise the most recently seen connected computer says why not.
 */
export const chatLocalHarnessOptions = (
  readiness: ChatLocalRunReadiness | undefined,
): ChatLocalHarnessOption[] | null => {
  if (readiness === undefined || readiness.status === "hidden") {
    return null;
  }
  const connected = readiness.runners.filter((runner) => runner.connected);
  return CHAT_LOCAL_RUN_HARNESSES.map((harness) => {
    if (connected.length === 0) {
      return { harness, state: "offline" };
    }
    const reports = connected.flatMap((runner) =>
      runner.harnesses.filter((report) => report.id === harness),
    );
    return optionOf(
      harness,
      reports.find((report) => report.state === "ready") ?? reports.at(0),
    );
  });
};

/**
 * What the Run on menu offers for each harness on the computers a turn on
 * `target` can run on. A turn in a linked folder runs only on the folder's
 * computer, so only that computer's reports count for it, however ready
 * another computer is; any connected computer counts otherwise.
 */
export const chatLocalHarnessOptionsFor = (
  readiness: ChatLocalRunReadiness | undefined,
  target: ChatRunTarget,
): ChatLocalHarnessOption[] | null => {
  if (
    readiness?.status !== "enabled" ||
    target.kind !== "local" ||
    target.folder === undefined
  ) {
    return chatLocalHarnessOptions(readiness);
  }
  const { desktopId } = target.folder;
  return chatLocalHarnessOptions({
    ...readiness,
    runners: readiness.runners.filter(
      (runner) => runner.desktopId === desktopId,
    ),
  });
};

/**
 * A folder linked on one of the member's computers, as the Run on menu
 * offers it: `computer_offline` while its computer is not connected,
 * whatever it reported before.
 */
export type ChatLocalFolderOption = {
  folder: ChatLocalRunFolder;
  state: DesktopRunnerLinkedFolderState | "computer_offline";
  approval: ChatLocalFolderApproval;
};

/** Every folder linked on the member's computers, most recently seen first. */
export const chatLocalFolderOptions = (
  readiness: ChatLocalRunReadiness | undefined,
): ChatLocalFolderOption[] =>
  readiness?.status === "enabled"
    ? readiness.runners.flatMap((runner) =>
        runner.linkedFolders.map((linked): ChatLocalFolderOption => ({
          folder: {
            desktopId: runner.desktopId,
            linkId: linked.id,
            name: linked.name,
          },
          state: runner.connected ? linked.state : "computer_offline",
          approval: linked.approval,
        })),
      )
    : [];

/** The option of the folder a target works in; `undefined` once unlinked. */
export const chatLocalFolderOption = (
  readiness: ChatLocalRunReadiness | undefined,
  folder: ChatLocalRunFolder,
): ChatLocalFolderOption | undefined =>
  chatLocalFolderOptions(readiness).find(
    (option) =>
      option.folder.desktopId === folder.desktopId &&
      option.folder.linkId === folder.linkId,
  );

/** Why a target's linked folder cannot take a turn now. */
export type LocalRunFolderProblem =
  | Exclude<
      ChatLocalFolderOption["state"],
      typeof DESKTOP_RUNNER_LINKED_FOLDER_STATE.available
    >
  | "unlinked";

/**
 * Whether the member's computers can take a turn on `target` now, read as
 * the Run on menu reads them (the harness option a send is routed by, on
 * the linked folder's computer when the target names one):
 * `ready`; why its harness cannot (offline, signed out); `model_unavailable`
 * when the ready harness no longer offers the model, which the API would
 * refuse; `not_allowed` when the member may not run turns on a computer.
 */
export type LocalRunTargetState =
  | { type: "ready" }
  | {
      type: "harness";
      option: Exclude<ChatLocalHarnessOption, { state: "ready" }>;
    }
  | { type: "model_unavailable" }
  | { type: "not_allowed" }
  /** The target's linked folder cannot take a turn now. */
  | { type: "folder"; problem: LocalRunFolderProblem }
  /** The member has not yet let turns work in the target's linked folder. */
  | { type: "folder_pending" };

const folderState = (
  readiness: ChatLocalRunReadiness,
  folder: ChatLocalRunFolder,
): LocalRunTargetState => {
  const option = chatLocalFolderOption(readiness, folder);
  if (option === undefined) {
    return { type: "folder", problem: "unlinked" };
  }
  if (option.state !== DESKTOP_RUNNER_LINKED_FOLDER_STATE.available) {
    return { type: "folder", problem: option.state };
  }
  return option.approval === "approved"
    ? { type: "ready" }
    : { type: "folder_pending" };
};

export const localRunTargetState = (
  readiness: ChatLocalRunReadiness,
  target: ChatLocalRunTarget,
): LocalRunTargetState => {
  if (readiness.status !== "enabled") {
    return { type: "not_allowed" };
  }
  // A turn in a linked folder runs only on the folder's computer: a folder
  // that cannot take one (unlinked, away, its computer offline) says so
  // first, and only that computer's harness and models count.
  const folder =
    target.folder === undefined ? null : folderState(readiness, target.folder);
  if (folder?.type === "folder") {
    return folder;
  }
  const option = chatLocalHarnessOptionsFor(readiness, target)?.find(
    ({ harness }) => harness === target.harness,
  );
  if (option === undefined) {
    return { type: "not_allowed" };
  }
  if (option.state !== "ready") {
    return { type: "harness", option };
  }
  if (!option.models.some(({ id }) => id === target.model)) {
    return { type: "model_unavailable" };
  }
  return folder ?? { type: "ready" };
};

/**
 * The name a harness reports for the thread's model, from any computer whose
 * last report offers it. A disconnected computer's report still names the
 * model correctly, so the composer keeps the name while the computer is away;
 * `null` while no computer reports it, so the composer shows the model id.
 */
export const localRunModelLabel = (
  readiness: ChatLocalRunReadiness | undefined,
  target: ChatLocalRunTarget,
): string | null => {
  if (readiness === undefined || readiness.status === "hidden") {
    return null;
  }
  for (const runner of readiness.runners) {
    for (const report of runner.harnesses) {
      if (report.id !== target.harness || report.state !== "ready") {
        continue;
      }
      const model = report.models.find(({ id }) => id === target.model);
      if (model !== undefined) {
        return model.label;
      }
    }
  }
  return null;
};

/**
 * The most the organization lets a run do without asking, as the member's
 * computers were last read; every mode until they are, since the API holds
 * each turn to the stored ceiling either way.
 */
export const localRunMaxApprovals = (
  readiness: ChatLocalRunReadiness | undefined,
): DesktopRunnerApprovalMode =>
  readiness?.status === "enabled"
    ? readiness.maxApprovals
    : CHAT_LOCAL_RUN_DEFAULT_MAX_APPROVALS;

const SEPARATOR = "::";

/** A ready harness's model, as its report lists it. */
export type LocalHarnessModel = Extract<
  ChatLocalHarnessOption,
  { state: "ready" }
>["models"][number];

/**
 * The model a ready harness runs when none is named: the one its report
 * marks, else its first. Offered first, as the recommended one.
 */
export const defaultHarnessModel = (
  option: Extract<ChatLocalHarnessOption, { state: "ready" }>,
): LocalHarnessModel =>
  option.models.find(({ isDefault }) => isDefault === true) ??
  option.models.at(0) ??
  panic("A ready harness reports at least one model");

/**
 * Where a turn runs, as the where chip's radio value: stella's models in
 * the cloud, or one harness on the member's computer whatever its model.
 */
export const runOnPlaceValue = (target: ChatRunTarget): string =>
  target.kind === "local"
    ? `${CHAT_RUN_TARGET_KIND.local}${SEPARATOR}${target.harness}`
    : CHAT_RUN_TARGET_KIND.cloud;

/**
 * The menu's radio value for where a turn runs: the harness and model, not
 * the permission mode, which has its own choice.
 */
export const runTargetValue = (target: ChatRunTarget): string =>
  target.kind === "local"
    ? `${target.harness}${SEPARATOR}${target.model}`
    : CHAT_RUN_TARGET_KIND.cloud;

/** The Folder choice's radio value: the link's id, or the chat's own folder. */
export const CHAT_OWN_FOLDER_VALUE = "chat";

export const runFolderValue = (target: ChatLocalRunTarget): string =>
  target.folder?.linkId ?? CHAT_OWN_FOLDER_VALUE;

/**
 * Whether two targets run a turn the same way, permission mode, reasoning
 * effort and folder included.
 */
export const sameRunTarget = (
  left: ChatRunTarget,
  right: ChatRunTarget,
): boolean =>
  runTargetValue(left) === runTargetValue(right) &&
  (left.kind !== "local" ||
    right.kind !== "local" ||
    (left.approvals === right.approvals &&
      left.reasoningEffort === right.reasoningEffort &&
      left.folder?.desktopId === right.folder?.desktopId &&
      runFolderValue(left) === runFolderValue(right)));

/** The target working in `folder`, or in the chat's own folder without one. */
export const withRunFolder = (
  target: ChatLocalRunTarget,
  folder: ChatLocalRunFolder | undefined,
): ChatLocalRunTarget => ({
  kind: target.kind,
  harness: target.harness,
  model: target.model,
  reasoningEffort: target.reasoningEffort,
  approvals: target.approvals,
  ...(folder === undefined ? {} : { folder }),
});

/**
 * The target for a model picked under a ready harness. The permission mode
 * carries over when this harness can run in it, and is Ask otherwise; a mode
 * above the organization's ceiling falls to the highest one it allows. The
 * reasoning effort carries over when the picked model offers it, and is the
 * harness's default otherwise.
 */
export const localRunTargetFor = ({
  selected,
  option,
  model,
  maxApprovals,
}: {
  selected: ChatRunTarget;
  option: Extract<ChatLocalHarnessOption, { state: "ready" }>;
  model: string;
  maxApprovals: DesktopRunnerApprovalMode;
}): ChatRunTarget => {
  const effort = selected.kind === "local" ? selected.reasoningEffort : null;
  // No such model offers no effort.
  const offered = option.models.find(
    ({ id }) => id === model,
  )?.reasoningEfforts;
  return {
    kind: "local",
    harness: option.harness,
    model,
    reasoningEffort:
      effort !== null && offered?.includes(effort) === true ? effort : null,
    // The folder stays the chat's whichever harness and model work in it.
    ...(selected.kind === "local" && selected.folder !== undefined
      ? { folder: selected.folder }
      : {}),
    approvals: approvalModeWithin({
      mode:
        selected.kind === "local" &&
        option.approvalModes.includes(selected.approvals)
          ? selected.approvals
          : DESKTOP_RUNNER_DEFAULT_APPROVAL_MODE,
      ceiling: maxApprovals,
      offered: option.approvalModes,
    }),
  };
};

/**
 * The reasoning efforts the selected local model offers, or `null` when the
 * turn runs in the cloud, its harness cannot take a turn, or the model offers
 * no choice; the menu then shows none.
 */
export const reasoningEffortChoices = (
  selected: ChatRunTarget,
  options: readonly ChatLocalHarnessOption[],
): readonly DesktopRunnerReasoningEffort[] | null => {
  if (selected.kind !== "local") {
    return null;
  }
  const option = options.find(({ harness }) => harness === selected.harness);
  if (option?.state !== "ready") {
    return null;
  }
  const efforts =
    option.models.find(({ id }) => id === selected.model)?.reasoningEfforts ??
    [];
  return efforts.length === 0 ? null : efforts;
};

/**
 * Whether a permission mode can be chosen: `computer` when the computer
 * cannot run the harness in it, `organization` when it is above what the
 * organization allows.
 */
export type PermissionAvailability = "available" | "computer" | "organization";

/**
 * What the menu shows about permissions for the selected target: a choice of
 * modes, each with whether it can be chosen and why not; the harness's one
 * fixed behaviour when it reports a single mode, so nothing is offered that
 * would run the same way; `null` when the turn runs in the cloud or its
 * harness cannot take a turn.
 */
export type PermissionView =
  | {
      type: "choice";
      modes: {
        mode: DesktopRunnerApprovalMode;
        availability: PermissionAvailability;
      }[];
    }
  | { type: "fixed"; harness: ChatLocalRunHarness };

const availabilityOf = (
  mode: DesktopRunnerApprovalMode,
  offered: readonly DesktopRunnerApprovalMode[],
  maxApprovals: DesktopRunnerApprovalMode,
): PermissionAvailability => {
  if (!offered.includes(mode)) {
    return "computer";
  }
  return isApprovalModeWithin(mode, maxApprovals)
    ? "available"
    : "organization";
};

export const permissionView = (
  selected: ChatRunTarget,
  options: readonly ChatLocalHarnessOption[],
  maxApprovals: DesktopRunnerApprovalMode,
): PermissionView | null => {
  if (selected.kind !== "local") {
    return null;
  }
  const option = options.find(({ harness }) => harness === selected.harness);
  if (option?.state !== "ready") {
    return null;
  }
  if (option.approvalModes.length <= 1) {
    return { type: "fixed", harness: option.harness };
  }
  return {
    type: "choice",
    modes: DESKTOP_RUNNER_APPROVAL_MODES.map((mode) => ({
      mode,
      availability: availabilityOf(mode, option.approvalModes, maxApprovals),
    })),
  };
};

/**
 * The target a turn should carry. A local target whose harness no longer
 * offers its model is still sent: the API refuses it with a reason the member
 * can read, rather than the page silently moving the turn to the cloud. A
 * thread whose permission mode is now above the organization's ceiling runs
 * its next turn in the highest mode the ceiling allows and the computer
 * offers.
 */
export const effectiveRunTarget = (
  target: ChatRunTarget | undefined,
  readiness?: ChatLocalRunReadiness,
): ChatRunTarget => {
  const chosen = target ?? CHAT_CLOUD_RUN_TARGET;
  if (chosen.kind !== "local" || readiness?.status !== "enabled") {
    return chosen;
  }
  const option = chatLocalHarnessOptionsFor(readiness, chosen)?.find(
    ({ harness }) => harness === chosen.harness,
  );
  const approvals = approvalModeWithin({
    mode: chosen.approvals,
    ceiling: readiness.maxApprovals,
    offered: option?.state === "ready" ? option.approvalModes : undefined,
  });
  return approvals === chosen.approvals ? chosen : { ...chosen, approvals };
};
