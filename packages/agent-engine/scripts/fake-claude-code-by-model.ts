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
  await run(listingScenarios(stepsFor(FAKE_SCENARIOS[scenario], args)), log);
  process.exit(0);
}
