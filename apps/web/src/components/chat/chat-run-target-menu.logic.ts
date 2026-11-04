import { panic } from "better-result";

import {
  CHAT_CLOUD_RUN_TARGET,
  CHAT_LOCAL_RUN_HARNESSES,
  CHAT_RUN_TARGET_KIND,
  type ChatLocalHarnessReadiness,
  type ChatLocalRunHarness,
  type ChatLocalRunReadiness,
  type ChatLocalRunTarget,
  type ChatRunTarget,
} from "@stll/api-contract/chat-run-target";

/** Product names of the harnesses, shown as they are in every locale. */
export const CHAT_LOCAL_HARNESS_NAMES = {
  codex: "Codex",
  "claude-code": "Claude Code",
} as const satisfies Record<ChatLocalRunHarness, string>;

type HarnessState = ChatLocalHarnessReadiness["state"];

/**
 * One harness as the Run on menu offers it: ready with its models, or why it
 * cannot take a turn right now. `offline` means no computer of the member is
 * connected, whatever it reported before.
 */
export type ChatLocalHarnessOption =
  | {
      harness: ChatLocalRunHarness;
      state: "ready";
      models: readonly { id: string; label: string }[];
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
      return { harness, state: "ready", models: report.models };
    case "limit_until":
      return { harness, state: "limit_until", resetsAt: report.resetsAt };
    case "needs_login":
    case "not_installed":
    case "unsupported":
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

const SEPARATOR = "::";

/** The menu's radio value for a run target. */
export const runTargetValue = (target: ChatRunTarget): string =>
  target.kind === "local"
    ? `${target.harness}${SEPARATOR}${target.model}`
    : CHAT_RUN_TARGET_KIND.cloud;

/**
 * The target a turn should carry. A local target whose harness no longer
 * offers its model is still sent: the API refuses it with a reason the member
 * can read, rather than the page silently moving the turn to the cloud.
 */
export const effectiveRunTarget = (
  target: ChatRunTarget | undefined,
): ChatRunTarget => target ?? CHAT_CLOUD_RUN_TARGET;
