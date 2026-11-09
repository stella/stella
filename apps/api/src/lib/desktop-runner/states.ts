import type {
  DesktopRunnerDesktopMessage,
  DesktopRunnerServerMessage,
} from "@stll/api-contract/desktop-runner";

// The schema reads these lists, and schema modules enumerate metadata only,
// so they import the wire contract for its types. Each list is held equal to
// the contract's union at compile time.
type Same<TLeft, TRight> = [TLeft] extends [TRight]
  ? [TRight] extends [TLeft]
    ? true
    : false
  : false;

type DesktopMessageOf<TType extends DesktopRunnerDesktopMessage["type"]> =
  Extract<DesktopRunnerDesktopMessage, { type: TType }>;

/** Whether a desktop's latest runner socket is open. */
export const DESKTOP_RUNNER_CONNECTIONS = [
  "connected",
  "disconnected",
] as const;

/**
 * Where a run assigned to a desktop stands.
 *
 * - `assigned`: `run.start` is queued; the desktop has not accepted it.
 * - `running`: the desktop accepted it and holds it.
 * - `waiting_for_computer`: its lease expired while the desktop was away. The
 *   run stays bound to that desktop: it resumes when the desktop reconnects
 *   and is never handed to another one.
 * - `finished`, `rejected`, `lost` are final. `lost` means the desktop came
 *   back without a run it had accepted.
 */
export const DESKTOP_RUNNER_RUN_STATES = [
  "assigned",
  "running",
  "waiting_for_computer",
  "finished",
  "rejected",
  "lost",
] as const;
export type DesktopRunnerRunState = (typeof DESKTOP_RUNNER_RUN_STATES)[number];

/** States in which a run is still bound to its desktop and takes commands. */
export const DESKTOP_RUNNER_OPEN_RUN_STATES = [
  "assigned",
  "running",
  "waiting_for_computer",
] as const satisfies readonly DesktopRunnerRunState[];

/** States whose lease the holding socket renews. */
export const DESKTOP_RUNNER_LEASED_RUN_STATES = [
  "assigned",
  "running",
] as const satisfies readonly DesktopRunnerRunState[];

/** How a finished run ended, as its `run.finished` said. */
export const DESKTOP_RUNNER_STORED_OUTCOMES = [
  "completed",
  "interrupted",
  "cancelled",
  "failed",
  "limit_reached",
  "needs_login",
] as const;
true satisfies Same<
  (typeof DESKTOP_RUNNER_STORED_OUTCOMES)[number],
  DesktopMessageOf<"run.finished">["outcome"]
>;

/** Why a desktop refused a run, as its `run.rejected` said. */
export const DESKTOP_RUNNER_STORED_REJECT_REASONS = [
  "harness_not_installed",
  "harness_needs_login",
  "harness_limited",
  "harness_unsupported",
  "harness_unavailable",
  "harness_version_unavailable",
  "model_unavailable",
  "policy_unsupported",
  "at_capacity",
  "run_too_large",
  "unknown_run",
  "folder_busy",
] as const;
true satisfies Same<
  (typeof DESKTOP_RUNNER_STORED_REJECT_REASONS)[number],
  DesktopMessageOf<"run.rejected">["reason"]
>;

/**
 * Server commands kept until the run ends and replayed on every reconnect.
 * `run.token` is absent: a token is minted when it is sent and never stored.
 */
export const DESKTOP_RUNNER_COMMAND_KINDS = [
  "run.start",
  "run.input",
  "run.approval",
  "run.answer",
  "run.interrupt",
  "run.cancel",
] as const;
true satisfies Same<
  (typeof DESKTOP_RUNNER_COMMAND_KINDS)[number],
  Exclude<
    DesktopRunnerServerMessage["type"],
    | "welcome"
    | "upgrade_required"
    | "reconnect"
    | "run.token"
    | "ack"
    | "folder.restore"
  >
>;
export type DesktopRunnerCommandKind =
  (typeof DESKTOP_RUNNER_COMMAND_KINDS)[number];

/**
 * Where a folder restore stands: waiting to be sent (`queued`, until it
 * expires), sent and not answered (`sent`, sent again on the desktop's next
 * socket), done (`restored`), refused by the computer (`refused`, with its
 * reason), or never sent in time (`expired`).
 */
export const DESKTOP_RUNNER_FOLDER_RESTORE_STATES = [
  "queued",
  "sent",
  "restored",
  "refused",
  "expired",
] as const;
export type DesktopRunnerFolderRestoreState =
  (typeof DESKTOP_RUNNER_FOLDER_RESTORE_STATES)[number];

/** States in which a turn's restore counts: a turn has at most one. */
export const DESKTOP_RUNNER_LIVE_FOLDER_RESTORE_STATES = [
  "queued",
  "sent",
  "restored",
] as const satisfies readonly DesktopRunnerFolderRestoreState[];

/** States a restore ends in; each records when it settled. */
export const DESKTOP_RUNNER_SETTLED_FOLDER_RESTORE_STATES = [
  "restored",
  "refused",
  "expired",
] as const satisfies readonly DesktopRunnerFolderRestoreState[];

/** Why the computer refused a restore, as its `folder.restored` said. */
export const DESKTOP_RUNNER_FOLDER_RESTORE_REFUSALS = [
  "no_checkpoint",
  "not_newest",
  "folder_busy",
  "failed",
] as const;
true satisfies Same<
  (typeof DESKTOP_RUNNER_FOLDER_RESTORE_REFUSALS)[number],
  Exclude<DesktopMessageOf<"folder.restored">["outcome"], "restored">
>;
export type DesktopRunnerFolderRestoreRefusal =
  (typeof DESKTOP_RUNNER_FOLDER_RESTORE_REFUSALS)[number];

/** Desktop messages that take a position in their run's sequence. */
export const DESKTOP_RUNNER_EVENT_TYPES = [
  "run.event",
  "run.approval_request",
  "run.finished",
] as const;
true satisfies Same<
  (typeof DESKTOP_RUNNER_EVENT_TYPES)[number],
  Extract<DesktopRunnerDesktopMessage, { seq: number }>["type"]
>;
export type DesktopRunnerEventType =
  (typeof DESKTOP_RUNNER_EVENT_TYPES)[number];
