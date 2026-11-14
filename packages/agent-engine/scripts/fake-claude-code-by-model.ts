import { Temporal } from "temporal-polyfill/full";

import {
  FAKE_SCENARIOS,
  type FakeStep,
  run,
  stepsFor,
} from "./fake-claude-code-cli";
import { fakeHarnessLog } from "./fake-harness-peer";

/**
 * A stand-in for an installed Claude Code CLI whose models are scenarios of
 * `fake-claude-code-cli.ts`, so a person or an agent picks a scenario in the
 * chat's model menu. A turn plays the scenario its `--model` names; a launch
 * without one (a probe) reports the scenarios as the CLI's models. The local
 * stack's stand-in computer installs it as Claude Code
 * (`bun run agent:up -- --local-runner`).
 *
 * `usage_limit` resets after the turn, not at the shared fixture's fixed times.
 *
 * Usage: `bun scripts/fake-claude-code-by-model.ts [CLI arguments]`.
 */

/** The scenarios the model menu offers, in its order. */
export const CLAUDE_BY_MODEL_SCENARIOS = [
  "tool_calls",
  "stella_tools",
  "approvals",
  "question",
  "interrupt",
  "usage_limit",
] as const;

type ByModelScenario = (typeof CLAUDE_BY_MODEL_SCENARIOS)[number];

const isByModelScenario = (model: string): model is ByModelScenario =>
  CLAUDE_BY_MODEL_SCENARIOS.some((scenario) => scenario === model);

const MODEL_ROWS = CLAUDE_BY_MODEL_SCENARIOS.map((value) => ({
  value,
  resolvedModel: value,
  displayName: value,
  description: "",
}));

/** `steps` with the CLI's model list replaced by the scenarios. */
const listingScenarios = (steps: readonly FakeStep[]): FakeStep[] =>
  steps.map((step) =>
    "expect" in step &&
    step.expect === "initialize" &&
    typeof step.response === "object" &&
    step.response !== null
      ? { ...step, response: { ...step.response, models: MODEL_ROWS } }
      : step,
  );

/** How long after the turn each limit `usage_limit` rejects resets. */
const LIMIT_RESETS_IN = new Map([
  ["five_hour", Temporal.Duration.from({ hours: 5 })],
  ["seven_day_opus", Temporal.Duration.from({ hours: 24 * 7 })],
]);

/** `steps` with each rejected limit resetting `LIMIT_RESETS_IN` from now. */
const futureResets = (steps: readonly FakeStep[]): FakeStep[] => {
  const now = Temporal.Now.instant();
  return steps.map((step) => {
    if (!("emit" in step) || !("rate_limit_info" in step.emit)) {
      return step;
    }
    const info = step.emit.rate_limit_info;
    const resetsIn =
      typeof info === "object" &&
      info !== null &&
      "rateLimitType" in info &&
      typeof info.rateLimitType === "string"
        ? LIMIT_RESETS_IN.get(info.rateLimitType)
        : undefined;
    return resetsIn === undefined
      ? step
      : {
          emit: {
            ...step.emit,
            rate_limit_info: {
              ...info,
              resetsAt: Math.floor(now.add(resetsIn).epochMilliseconds / 1000),
            },
          },
        };
  });
};

/**
 * The scenario a turn's `--model` names, the first for a model it does not
 * list; a probe, which opens no session, lists them.
 */
export const scenarioForArgs = (args: readonly string[]) => {
  if (!args.includes("--session-id") && !args.includes("--resume")) {
    return "probe_available";
  }
  const index = args.indexOf("--model");
  const model = index === -1 ? undefined : args[index + 1];
  return model !== undefined && isByModelScenario(model)
    ? model
    : CLAUDE_BY_MODEL_SCENARIOS[0];
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const log = fakeHarnessLog();
  const scenario = scenarioForArgs(args);
  log({ startup: { args, pid: process.pid }, scenario });
  const steps = stepsFor(FAKE_SCENARIOS[scenario], args);
  await run(
    listingScenarios(scenario === "usage_limit" ? futureResets(steps) : steps),
    log,
  );
  process.exit(0);
}
