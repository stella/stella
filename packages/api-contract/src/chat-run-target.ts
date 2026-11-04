import * as v from "valibot";

import type { AgentHarness } from "./agent-harness";
import {
  DESKTOP_RUNNER_HARNESS_STATE,
  type DesktopRunnerHarnessReport,
} from "./desktop-runner";

/**
 * Where a chat turn runs. `cloud` is stella's own model path and the default;
 * `local` hands the turn to a coding-agent harness on one of the member's
 * connected computers, which streams it back through the same turn pipeline.
 */
export const CHAT_RUN_TARGET_KIND = {
  cloud: "cloud",
  local: "local",
} as const;

/**
 * Harnesses a chat turn can run on a computer: the ones the desktop has an
 * adapter for. A harness id outside this list is refused at the boundary.
 */
export const CHAT_LOCAL_RUN_HARNESSES = [
  "codex",
  "claude-code",
] as const satisfies readonly AgentHarness[];
export type ChatLocalRunHarness = (typeof CHAT_LOCAL_RUN_HARNESSES)[number];

export const isChatLocalRunHarness = (
  harness: AgentHarness,
): harness is ChatLocalRunHarness =>
  CHAT_LOCAL_RUN_HARNESSES.some((candidate) => candidate === harness);

/** Matches the runner protocol's model id bound. */
const localModelSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

export const chatLocalRunTargetSchema = v.strictObject({
  kind: v.literal("local"),
  harness: v.picklist(CHAT_LOCAL_RUN_HARNESSES),
  model: localModelSchema,
});
export type ChatLocalRunTarget = v.InferOutput<typeof chatLocalRunTargetSchema>;

export const chatRunTargetSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal(CHAT_RUN_TARGET_KIND.cloud) }),
  chatLocalRunTargetSchema,
]);
export type ChatRunTarget = v.InferOutput<typeof chatRunTargetSchema>;

export const CHAT_CLOUD_RUN_TARGET = {
  kind: CHAT_RUN_TARGET_KIND.cloud,
} as const satisfies ChatRunTarget;

/**
 * Why a turn bound for a computer was refused before it started. The send
 * answers with one of these as its error `code`; nothing falls back to cloud.
 */
export const CHAT_LOCAL_RUN_REFUSAL = {
  /** Running chat turns on a computer is not enabled for this member. */
  unavailable: "local_run_unavailable",
  /** None of the member's computers has a runner connected. */
  noComputer: "local_run_no_computer",
  /** The computer is connected but the harness cannot take a run now. */
  harnessUnavailable: "local_run_harness_unavailable",
  /** The harness no longer offers the chosen model. */
  modelUnavailable: "local_run_model_unavailable",
  /** The turn does not fit what one run may carry. */
  tooLarge: "local_run_too_large",
  /** A turn cannot both run in the agent sandbox and on a computer. */
  conflictingRunMode: "local_run_conflicting_run_mode",
} as const;
export type ChatLocalRunRefusal =
  (typeof CHAT_LOCAL_RUN_REFUSAL)[keyof typeof CHAT_LOCAL_RUN_REFUSAL];

/** One harness on one computer, as its runner last reported it. */
export type ChatLocalHarnessReadiness = DesktopRunnerHarnessReport & {
  id: ChatLocalRunHarness;
};

/** One of the member's computers that has held a runner socket. */
export type ChatLocalRunnerReadiness = {
  desktopId: string;
  /** Whether its runner socket is open and was seen recently. */
  connected: boolean;
  lastSeenAt: string;
  harnesses: ChatLocalHarnessReadiness[];
};

/**
 * What the composer may offer for local runs. `hidden` when the member cannot
 * run chat turns on a computer at all; the composer then shows no option.
 */
export type ChatLocalRunReadiness =
  | { status: "hidden" }
  | { status: "enabled"; runners: ChatLocalRunnerReadiness[] };

export const CHAT_LOCAL_HARNESS_STATE = DESKTOP_RUNNER_HARNESS_STATE;
