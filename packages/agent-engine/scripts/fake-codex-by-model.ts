import { Temporal } from "temporal-polyfill/full";

import {
  FAKE_SCENARIOS,
  type FakeScenario,
  type FakeStep,
  handshake,
  isScenario,
  openCodexPeer,
  run,
  skillDiscovery,
  usageLimitTurn,
} from "./fake-codex-app-server";
import { fakeHarnessLog } from "./fake-harness-peer";

/**
 * A stand-in for an installed `codex` whose models are scenarios of
 * `fake-codex-app-server.ts`, so a person or an agent picks a scenario in the
 * chat's model menu. It answers the handshake and `model/list` itself, one
 * model per scenario, then plays the scenario a thread's model names. A
 * `slow_<scenario>` model plays it with `FAKE_CODEX_PACE_MS` before each
 * output. `usage_limit` resets an hour from now. The local stack's stand-in
 * computer installs it as Codex (`bun run agent:up -- --local-runner`).
 *
 * Usage: `bun scripts/fake-codex-by-model.ts [codex arguments]`.
 */

/** The scenarios the model menu offers, in its order; the first is default. */
export const BY_MODEL_SCENARIOS = [
  "text",
  "tool_calls",
  "native_tools",
  "harness_items",
  "stella_tools",
  "approval",
  "approval_outcome",
  "writes_file",
  "blocking_question",
  "async_question",
  "usage_limit",
  "slow_text",
  "slow_tool_calls",
  "slow_approval",
  "slow_blocking_question",
] as const;

type ByModelScenario = (typeof BY_MODEL_SCENARIOS)[number];

const SLOW_PREFIX = "slow_";
const PACE_MS = Number(process.env["FAKE_CODEX_PACE_MS"] ?? "2000");
const LIMIT_RESETS_IN = Temporal.Duration.from({ hours: 1 });

const isByModelScenario = (model: string): model is ByModelScenario =>
  BY_MODEL_SCENARIOS.some((scenario) => scenario === model);

const BY_MODEL_LIST = {
  data: BY_MODEL_SCENARIOS.map((id, index) => ({
    id,
    model: id,
    displayName: id,
    description: "",
    hidden: false,
    isDefault: index === 0,
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
  })),
  nextCursor: null,
};

/** Each output of `steps` after a pause, so a turn takes long enough to watch. */
const paced = (steps: readonly FakeStep[]): FakeStep[] =>
  steps.flatMap((step): FakeStep[] =>
    "notify" in step || "request" in step ? [{ sleep: PACE_MS }, step] : [step],
  );

const scenarioSteps = (scenario: FakeScenario): readonly FakeStep[] => {
  if (scenario !== "usage_limit") {
    return FAKE_SCENARIOS[scenario];
  }
  const resetsAt = Temporal.Now.instant().add(LIMIT_RESETS_IN);
  return usageLimitTurn(Math.floor(resetsAt.epochMilliseconds / 1000));
};

/**
 * What follows the thread request a scenario expects first, and that
 * request's answer: this script has already answered the handshake.
 */
const afterThread = (steps: readonly FakeStep[]) => {
  const index = steps.findIndex(
    (step) =>
      "expect" in step &&
      (step.expect === "thread/start" || step.expect === "thread/resume"),
  );
  const thread = steps[index];
  return thread !== undefined && "expect" in thread
    ? { result: thread.result ?? {}, rest: steps.slice(index + 1) }
    : null;
};

/** The steps for a thread on `model`, or null for a model this does not list. */
const stepsForModel = (model: string) => {
  if (!isByModelScenario(model)) {
    return null;
  }
  const slow = model.startsWith(SLOW_PREFIX) && model !== "slow_text";
  const name = slow ? model.slice(SLOW_PREFIX.length) : model;
  if (!isScenario(name)) {
    return null;
  }
  const thread = afterThread(scenarioSteps(name));
  if (thread === null) {
    return null;
  }
  return {
    result: thread.result,
    rest: slow ? paced(thread.rest) : thread.rest,
  };
};

const modelOf = (params: unknown) =>
  typeof params === "object" &&
  params !== null &&
  "model" in params &&
  typeof params.model === "string"
    ? params.model
    : null;

const main = async () => {
  const log = fakeHarnessLog();
  log({ startup: { args: process.argv.slice(2), pid: process.pid } });
  const peer = openCodexPeer(log);
  const skills = skillDiscovery();
  const answers = new Map<string, unknown>();
  for (const step of handshake()) {
    if ("expect" in step) {
      answers.set(step.expect, step.result);
    }
  }
  answers.set("model/list", BY_MODEL_LIST);
  for (;;) {
    // await-in-loop: the conversation answers one request at a time.
    const message = await peer.take("requests");
    if (message === null) {
      return;
    }
    const method = message.method ?? "";
    const params: unknown = message["params"];
    if (method === "thread/start" || method === "thread/resume") {
      const model = modelOf(params);
      const steps = model === null ? null : stepsForModel(model);
      if (steps === null) {
        log({ unknownModel: model });
        peer.write({
          id: message.id,
          error: { code: -32_600, message: `unknown model ${String(model)}` },
        });
        continue;
      }
      log({ scenario: model });
      peer.write({ id: message.id, result: steps.result });
      await run(steps.rest, log, { peer, skills, models: BY_MODEL_LIST });
      return;
    }
    const answer = answers.get(method) ?? skills.answer(method, params);
    peer.write(
      answer === null
        ? {
            id: message.id,
            error: { code: -32_601, message: `stand-in: ${method}` },
          }
        : { id: message.id, result: answer },
    );
  }
};

if (import.meta.main) {
  await main();
  process.exit(0);
}
