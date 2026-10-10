import { panic } from "better-result";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import * as v from "valibot";

import { evaluate } from "./github-expression";

const stepSchema = v.looseObject({
  name: v.string(),
  id: v.optional(v.string()),
  run: v.optional(v.string()),
  uses: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
  if: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
  "continue-on-error": v.optional(v.union([v.boolean(), v.string()])),
});
const workflowSchema = v.looseObject({
  on: v.object({
    workflow_dispatch: v.object({ inputs: v.record(v.string(), v.unknown()) }),
  }),
  jobs: v.record(
    v.string(),
    v.looseObject({
      steps: v.optional(v.array(stepSchema)),
      outputs: v.optional(v.record(v.string(), v.string())),
    }),
  ),
});
const parse = (source: string) =>
  v.parse(workflowSchema, Bun.YAML.parse(source));
const source = readFileSync(
  new URL("../.github/workflows/deploy-staging.yml", import.meta.url),
  "utf-8",
);
const workflow = parse(source);
const findStep = (name: string, candidate = workflow) =>
  Object.values(candidate.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((step) => step.name === name) ??
  panic(`Missing workflow step: ${name}`);
const run = (script: string, env: Record<string, string>) => {
  const directory = mkdtempSync(path.join(tmpdir(), "staging-waiver-"));
  const output = path.join(directory, "output");
  const summary = path.join(directory, "summary");
  const payloads = path.join(directory, "payloads");
  // The retry helper runs gh in its own process, so the stub is an executable
  // on PATH rather than a shell function.
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "gh"),
    '#!/bin/bash\njq -c . >> "$STUB_PAYLOADS"\n',
    { mode: 0o755 },
  );
  try {
    const result = Bun.spawnSync(["bash", "-c", script], {
      env: {
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        GH_RETRY_SCRIPT: path.resolve(import.meta.dir, "gh-retry.sh"),
        ...env,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        STUB_PAYLOADS: payloads,
      },
    });
    const read = (file: string) =>
      existsSync(file) ? readFileSync(file, "utf-8") : "";
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      output: read(output),
      summary: read(summary),
      payloads: read(payloads),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
const validation = (
  overrides: Record<string, string> = {},
  candidate = workflow,
) =>
  run(
    findStep("Validate staging waiver", candidate).run ??
      panic("Missing waiver validator"),
    {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      REQUESTED_SHA: "a".repeat(40),
      WAIVE_CHECK: "corpus-search",
      WAIVE_REASON:
        "Backend verification deferred; evidence=artifacts/corpus-check.log",
      ...overrides,
    },
  );
const expression = (value: boolean | string | undefined, waived: boolean) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === undefined) {
    return false;
  }
  const result: unknown = new Script(
    value
      .replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/u, "$1")
      .replaceAll(
        /steps\.([\w-]+)/gu,
        (_, id: string) => `steps[${JSON.stringify(id)}]`,
      ),
  ).runInNewContext({
    cancelled: () => false,
    needs: { resolve: { outputs: { corpus_search_waived: String(waived) } } },
    steps: {
      "smoke-deps": { conclusion: "success" },
      "corpus-preflight": { outcome: "failure", conclusion: "success" },
    },
  });
  return v.parse(v.boolean(), result);
};
const assertScope = (candidate = workflow) => {
  // These existing report-only checks are independent of the named waiver.
  const reportOnlySteps = new Set([
    "Run staging response policy checks",
    "Run staging API model-turn smoke",
  ]);
  for (const [jobName, job] of Object.entries(candidate.jobs)) {
    for (const step of job.steps ?? []) {
      if (
        step.name === "Login to GitHub Container Registry for browser images"
      ) {
        expect(jobName).toBe("promote-staging");
        expect(step.uses).toStartWith("docker/login-action@");
        expect(step.with?.["registry"]).toBe("ghcr.io");
        expect(step.if).toContain(
          "github.event.pull_request.head.repo.fork != true",
        );
        expect(step.if).toContain("github.token != ''");
        expect(step.if).not.toContain("corpus_search_waived");
        expect(step["continue-on-error"]).toBe(true);
        continue;
      }
      if (step.id === "corpus-preflight") {
        expect(jobName).toBe("promote-staging");
        expect(
          expression(step["continue-on-error"], false),
          "unwaived corpus remains blocking",
        ).toBe(false);
        expect(
          expression(step["continue-on-error"], true),
          "named corpus waiver applies",
        ).toBe(true);
        continue;
      }
      expect(
        step["continue-on-error"] ?? false,
        `${step.name} cannot inherit the corpus waiver`,
      ).toBe(jobName === "promote-staging" && reportOnlySteps.has(step.name));
    }
  }
};
const assertValidation = (candidate = workflow) => {
  expect(validation({}, candidate).code, "valid named waiver").toBe(0);
  for (const overrides of [
    { WAIVE_REASON: "" },
    { WAIVE_REASON: " \t " },
    { WAIVE_REASON: "Reason without evidence" },
    { WAIVE_REASON: "Reason evidence=" },
    { WAIVE_REASON: "Reason evidence=/" },
    { REQUESTED_SHA: "" },
    { REQUESTED_SHA: "  " },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_EVENT_NAME: "schedule" },
    { WAIVE_CHECK: "web-smoke" },
    { WAIVE_CHECK: "api-smoke" },
  ]) {
    expect(
      validation(overrides, candidate).code,
      JSON.stringify(overrides),
    ).toBe(1);
  }
};
const record = (overrides: Record<string, string> = {}, candidate = workflow) =>
  run(
    `gh() { jq -c . >> "$STUB_PAYLOADS"; }\n${findStep("Record staging verification", candidate).run ?? panic("Missing verification script")}`,
    {
      GITHUB_REPOSITORY: "stella/stella",
      GITHUB_RUN_ID: "1",
      GITHUB_SERVER_URL: "https://github.com",
      DEPLOY_SHA: "a".repeat(40),
      DEPLOYMENT_ID: "1",
      WEB_SMOKE: "success",
      API_SMOKE: "success",
      MCP_SMOKE: "skipped",
      CORPUS_PREFLIGHT: "failure",
      CORPUS_SEARCH_WAIVED: "true",
      WAIVE_REASON:
        "Backend verification deferred; evidence=artifacts/corpus-check.log",
      JOB_STATUS: "success",
      ...overrides,
    },
  );
const statuses = (result: ReturnType<typeof record>) =>
  v.parse(
    v.array(
      v.looseObject({
        state: v.string(),
        description: v.optional(v.string()),
        context: v.optional(v.string()),
      }),
    ),
    result.payloads
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  );

test("the sole named waiver validates before checkout and derives its downstream authorization", () => {
  const inputs = v.parse(
    v.object({
      waive_check: v.object({
        type: v.literal("choice"),
        default: v.literal("none"),
        options: v.array(v.string()),
      }),
      waive_reason: v.object({ type: v.literal("string") }),
    }),
    workflow.on.workflow_dispatch.inputs,
  );
  expect(inputs.waive_check.options).toEqual(["none", "corpus-search"]);
  expect(workflow.jobs["resolve"]?.steps?.at(1)?.id).toBe("waiver");
  expect(workflow.jobs["resolve"]?.outputs?.["corpus_search_waived"]).toBe(
    `\${{ steps.waiver.outputs.corpus_search_waived }}`,
  );
  const validatorEnv = findStep("Validate staging waiver").env;
  expect(validatorEnv?.["WAIVE_CHECK"]).toBe(
    `\${{ inputs.waive_check || 'none' }}`,
  );
  for (const check of ["none", "corpus-search", "", undefined]) {
    const evaluated = evaluate(
      validatorEnv?.["WAIVE_CHECK"] ?? panic("Missing waiver input binding"),
      {
        values: check === undefined ? {} : { "inputs.waive_check": check },
        fallback: () => "",
      },
    );
    expect(evaluated).toBe(check || "none");
    expect(
      validation({ WAIVE_CHECK: v.parse(v.string(), evaluated) }).code,
    ).toBe(0);
  }
  expect(validatorEnv?.["WAIVE_REASON"]).toBe(`\${{ inputs.waive_reason }}`);
  expect(validatorEnv?.["REQUESTED_SHA"]).toBe(`\${{ inputs.sha }}`);
  const recordEnv = findStep("Record staging verification").env;
  expect(recordEnv?.["CORPUS_SEARCH_WAIVED"]).toBe(
    `\${{ needs.resolve.outputs.corpus_search_waived }}`,
  );
  expect(recordEnv?.["WAIVE_REASON"]).toBe(`\${{ inputs.waive_reason }}`);
  expect(recordEnv?.["CORPUS_PREFLIGHT"]).toBe(
    `\${{ steps.corpus-preflight.outcome }}`,
  );
  assertValidation();
  expect(
    validation({
      WAIVE_CHECK: "none",
      WAIVE_REASON: "",
      REQUESTED_SHA: "",
      GITHUB_EVENT_NAME: "push",
    }).output,
  ).toBe("corpus_search_waived=false\n");
  expect(validation().output).toBe("corpus_search_waived=true\n");
  for (const reason of ["line\nbreak", "line\rbreak", "x".repeat(117)]) {
    expect(validation({ WAIVE_REASON: reason }).code).toBe(1);
  }
  const evidence = " evidence=./a.log";
  const longestReason = `${"x".repeat(116 - evidence.length)}${evidence}`;
  expect(validation({ WAIVE_REASON: longestReason }).code).toBe(0);
  expect(
    statuses(record({ WAIVE_REASON: longestReason })).at(0)?.description,
  ).toHaveLength(140);
});
test("only failed corpus preflight can use the waiver and its MCP dependency remains gated by the actual outcome", () => {
  assertScope();
  expect(expression(findStep("Run staging MCP user journeys").if, true)).toBe(
    false,
  );
  const result = record();
  expect(result.code, result.stderr).toBe(0);
  const payloads = statuses(result);
  expect(payloads.at(0)).toMatchObject({
    state: "success",
    context: "staging/verified",
    description:
      "waived: corpus-search (Backend verification deferred; evidence=artifacts/corpus-check.log)",
  });
  expect(payloads.at(1)?.state).toBe("success");
  expect(result.summary).toContain(
    "Corpus preflight result: failure; dependent MCP smoke result: skipped.",
  );
  expect(result.summary).toContain(
    "Reason: Backend verification deferred; evidence=artifacts/corpus-check.log",
  );
});
test("unused waiver keeps normal success and every unrelated failure remains blocking", () => {
  const unused = record({ CORPUS_PREFLIGHT: "success", MCP_SMOKE: "success" });
  expect(statuses(unused).at(0)).toMatchObject({
    state: "success",
    description: "Staging smoke success: run 1",
  });
  expect(unused.summary).toContain("Waiver unused");
  const normal = record({
    CORPUS_SEARCH_WAIVED: "false",
    CORPUS_PREFLIGHT: "success",
    MCP_SMOKE: "success",
  });
  expect(statuses(normal).at(0)?.state).toBe("success");
  expect(normal.summary).toBe("");
  for (const overrides of [
    { CORPUS_SEARCH_WAIVED: "false" },
    { WEB_SMOKE: "failure" },
    { API_SMOKE: "failure" },
    { JOB_STATUS: "failure" },
    { JOB_STATUS: "cancelled" },
    { CORPUS_PREFLIGHT: "skipped" },
    { CORPUS_PREFLIGHT: "cancelled" },
    { MCP_SMOKE: "failure" },
    { CORPUS_PREFLIGHT: "success", MCP_SMOKE: "failure" },
  ]) {
    const result = record(overrides);
    expect(result.code, result.stderr).toBe(0);
    expect(
      statuses(result).every(({ state }) => state === "failure"),
      JSON.stringify(overrides),
    ).toBe(true);
  }
});
test("waiver scope, required reason and manual-only boundary mutations are rejected", () => {
  const widened = structuredClone(workflow);
  findStep("Run staging web smoke", widened)["continue-on-error"] =
    findStep("Check staging corpus search backend")["continue-on-error"] ??
    panic("Missing corpus waiver");
  expect(() => assertScope(widened)).toThrow(
    "Run staging web smoke cannot inherit the corpus waiver",
  );
  const optional = parse(
    source
      .replace(
        ["-z ", '"$', "{WAIVE_REASON//[[:space:]]/}", '"'].join(""),
        '-z "required"',
      )
      .replace(
        '! "$WAIVE_REASON" =~ $evidence_path',
        '"required" != "required"',
      ),
  );
  expect(optional).not.toEqual(workflow);
  expect(() => assertValidation(optional)).toThrow("WAIVE_REASON");
  const pushed = parse(
    source.replace(
      '"$GITHUB_EVENT_NAME" != "workflow_dispatch"',
      '"manual" != "manual"',
    ),
  );
  expect(pushed).not.toEqual(workflow);
  expect(() => assertValidation(pushed)).toThrow("GITHUB_EVENT_NAME");
  const noEvidence = parse(
    source.replace(
      '! "$WAIVE_REASON" =~ $evidence_path',
      '"required" != "required"',
    ),
  );
  expect(noEvidence).not.toEqual(workflow);
  expect(() => assertValidation(noEvidence)).toThrow("WAIVE_REASON");
  const unknown = parse(
    source.replace(
      '*) echo "::error::Unknown staging check waiver."; exit 1 ;;',
      '*) echo "corpus_search_waived=true" >> "$GITHUB_OUTPUT" ;;',
    ),
  );
  expect(unknown).not.toEqual(workflow);
  expect(() => assertValidation(unknown)).toThrow("WAIVE_CHECK");
  const ignoredWeb = parse(source.replace('"$WEB_SMOKE" == "success" && ', ""));
  expect(ignoredWeb).not.toEqual(workflow);
  expect(
    statuses(record({ WEB_SMOKE: "failure" }, ignoredWeb)).at(0)?.state,
  ).toBe("success");
  expect(statuses(record({ WEB_SMOKE: "failure" })).at(0)?.state).toBe(
    "failure",
  );
});
