import { expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { isPathInside } from "../packages/portable-path/src/index";
import { evaluate } from "./github-expression";

const source = readFileSync(
  new URL("../.github/workflows/deploy-staging.yml", import.meta.url),
  "utf-8",
);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const promotionSteps = (candidate = source) => {
  const workflow: unknown = Bun.YAML.parse(candidate);
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
    throw new TypeError("Workflow jobs are required");
  }
  const promotion = workflow["jobs"]["promote-staging"];
  if (!isRecord(promotion) || !Array.isArray(promotion["steps"])) {
    throw new TypeError("Staging promotion steps are required");
  }
  return promotion["steps"].map((step: unknown) => {
    if (!isRecord(step)) {
      throw new TypeError("Workflow step must be an object");
    }
    return step;
  });
};
const text = (step: Record<string, unknown>, field: string): string => {
  const value = step[field];
  if (typeof value !== "string") {
    throw new TypeError(`Step ${String(step["name"])} requires ${field}`);
  }
  return value;
};
const stepNamed = (name: string, candidate = source) => {
  const step = promotionSteps(candidate).find(
    (entry) => entry["name"] === name,
  );
  if (step === undefined) {
    throw new TypeError(`Missing staging proof step: ${name}`);
  }
  return step;
};

const PROOF_STEPS = [
  "Run staging web smoke",
  "Run staging response policy checks",
  "Run staging API chat smoke",
  "Run staging API model-turn smoke",
  "Check staging corpus search backend",
  "Run staging MCP user journeys",
  "Run deployed application journeys",
  "Require mock-model journey success",
];
const assertReadinessGates = (candidate = source) => {
  const steps = promotionSteps(candidate);
  const preflight = steps.findIndex((step) => step["id"] === "proof-readiness");
  const postflight = steps.findIndex(
    (step) => step["id"] === "candidate-served-after-smokes",
  );
  expect(preflight).toBeGreaterThan(-1);
  expect(postflight).toBeGreaterThan(preflight);
  expect(
    steps.slice(preflight + 1, postflight).map((step) => text(step, "name")),
  ).toEqual([
    "Install dependencies",
    "Login to GitHub Container Registry for browser images",
    "Verify image-provided Chromium",
    ...PROOF_STEPS,
  ]);
  for (const name of PROOF_STEPS) {
    const condition = text(stepNamed(name, candidate), "if");
    for (const readiness of [
      "",
      "environment-unavailable",
      "environment-interrupted",
      "proof-tooling-failure",
    ]) {
      expect(
        evaluate(condition, {
          values: {
            "steps.proof-readiness.outputs.status": readiness,
            "steps.smoke-deps.conclusion": "success",
            "steps.corpus-preflight.outcome": "success",
          },
          status: {
            cancelled: false,
            success: true,
            failure: false,
            always: true,
          },
          fallback: () => "",
        }),
        `${name} must wait for readiness`,
      ).toBe(false);
    }
    expect(
      evaluate(condition, {
        values: {
          "steps.proof-readiness.outputs.status": "ready",
          "steps.smoke-deps.conclusion": "success",
          "steps.corpus-preflight.outcome": "success",
        },
        status: {
          cancelled: false,
          success: true,
          failure: false,
          always: true,
        },
        fallback: () => "",
      }),
      `${name} runs when ready`,
    ).toBe(true);
  }
};

test("every staging proof step waits for explicit readiness", () => {
  assertReadinessGates();
  const unguarded = source.replaceAll(
    " && steps.proof-readiness.outputs.status == 'ready'",
    "",
  );
  expect(unguarded).not.toBe(source);
  expect(() => assertReadinessGates(unguarded)).toThrow(
    "must wait for readiness",
  );
});

test("proof integrity is checked after journeys even when they fail or are cancelled", () => {
  const steps = promotionSteps();
  const integrity = stepNamed("Verify candidate staging commit after smokes");
  const condition = text(integrity, "if");
  for (const outcome of ["success", "failure", "cancelled"]) {
    expect(
      evaluate(condition, {
        values: { "steps.proof-readiness.outcome": "success" },
        status: {
          always: true,
          success: outcome === "success",
          failure: outcome === "failure",
          cancelled: outcome === "cancelled",
        },
      }),
    ).toBe(true);
  }
  const index = steps.findIndex(
    (step) => step["id"] === "candidate-served-after-smokes",
  );
  expect(index).toBeGreaterThan(
    steps.findIndex((step) => step["id"] === "mock-journeys"),
  );
  expect(index).toBeLessThan(
    steps.findIndex((step) => step["name"] === "Record staging verification"),
  );
  expect(text(integrity, "run")).toContain(
    'staging-proof-readiness-cli.ts" finish',
  );
});

test("proof tooling is preserved from the workflow revision before target checkout", () => {
  const steps = promotionSteps();
  const tooling = stepNamed("Checkout GitHub API tooling");
  expect(tooling["with"]).toMatchObject({
    ref: `\${{ github.workflow_sha }}`,
  });
  if (!isRecord(tooling["with"])) {
    throw new TypeError("Workflow tooling checkout inputs are required");
  }
  expect(tooling["with"]["sparse-checkout"]).toContain(
    "scripts/staging-proof-readiness.ts",
  );
  expect(tooling["with"]["sparse-checkout"]).toContain(
    "scripts/staging-proof-readiness-cli.ts",
  );
  const preserve = steps.findIndex(
    (step) =>
      step["name"] === "Preserve staging proof tooling across source checkouts",
  );
  const target = steps.findIndex(
    (step) => step["name"] === "Checkout deployed source",
  );
  expect(preserve).toBeGreaterThan(-1);
  expect(preserve).toBeLessThan(target);
  expect(
    text(
      stepNamed("Preserve staging proof tooling across source checkouts"),
      "run",
    ),
  ).toContain("STAGING_PROOF_GATE_DIR=");
  expect(
    text(
      stepNamed("Verify staging serves the release commit and environment"),
      "run",
    ),
  ).toContain('staging-proof-readiness-cli.ts" monitor');
});

const assertPreservedImports = (entrypoint: string) => {
  const pending = [entrypoint];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined) {
      throw new TypeError("Preserved import queue must contain a file");
    }
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    expect(
      existsSync(file),
      `Workflow tooling must preserve ${path.basename(file)}`,
    ).toBe(true);
    const content = readFileSync(file, "utf-8");
    for (const match of content.matchAll(
      /\b(?:from\s*|import\s*)["'](\.[^"']+)["']/gu,
    )) {
      const dependency = match.at(1);
      if (dependency === undefined) {
        throw new TypeError("Relative import must contain a module path");
      }
      pending.push(
        path.resolve(
          path.dirname(file),
          dependency.endsWith(".ts") ? dependency : `${dependency}.ts`,
        ),
      );
    }
  }
  return visited.size;
};

type CopySparseCheckoutFileOptions = {
  fixtureRoot: string;
  checkoutPath: string;
  relativeFile: string;
};
const copySparseCheckoutFile = ({
  fixtureRoot,
  checkoutPath,
  relativeFile,
}: CopySparseCheckoutFileOptions) => {
  const checkout = path.resolve(fixtureRoot, checkoutPath);
  const destination = path.resolve(checkout, relativeFile);
  if (
    !isPathInside(fixtureRoot, checkout) ||
    !isPathInside(checkout, destination)
  ) {
    throw new TypeError(
      "Sparse checkout fixture must remain inside its temporary directory",
    );
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(path.resolve(import.meta.dir, "..", relativeFile), destination);
};

const exercisePreservation = (preserveScript: string) => {
  const directory = mkdtempSync(
    path.resolve(import.meta.dir, "../.staging-proof-copy-test-"),
  );
  try {
    const tooling = stepNamed("Checkout GitHub API tooling");
    if (!isRecord(tooling["with"])) {
      throw new TypeError("Workflow tooling checkout inputs are required");
    }
    const workspace = path.join(directory, "workspace");
    const checkoutPath = text(tooling["with"], "path");
    const runnerTemp = path.join(directory, "runner-temp");
    mkdirSync(runnerTemp, { recursive: true });
    for (const relativeFile of text(tooling["with"], "sparse-checkout")
      .trim()
      .split(/\s+/u)) {
      copySparseCheckoutFile({
        fixtureRoot: workspace,
        checkoutPath,
        relativeFile,
      });
    }
    const result = Bun.spawnSync(["bash", "-c", preserveScript], {
      cwd: workspace,
      env: {
        PATH: process.env["PATH"] ?? "",
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
        GITHUB_ENV: path.join(directory, "github-env"),
      },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const environment = readFileSync(
      path.join(directory, "github-env"),
      "utf-8",
    );
    const gateDirectory = /^STAGING_PROOF_GATE_DIR=(.+)$/mu
      .exec(environment)
      ?.at(1);
    if (gateDirectory === undefined) {
      throw new TypeError(
        "Preservation must publish its proof tooling directory",
      );
    }
    return assertPreservedImports(
      path.join(gateDirectory, "staging-proof-readiness-cli.ts"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("preserved workflow tooling contains its complete relative import closure", () => {
  const script = text(
    stepNamed("Preserve staging proof tooling across source checkouts"),
    "run",
  );
  expect(exercisePreservation(script)).toBeGreaterThan(1);
  const helperCopy = script
    .split("\n")
    .findLast((line) => line.trimStart().startsWith("cp "));
  if (helperCopy === undefined) {
    throw new TypeError("Workflow tooling must copy its dependencies");
  }
  const missingHelper = script.replace(helperCopy, "");
  expect(missingHelper).not.toBe(script);
  expect(() => exercisePreservation(missingHelper)).toThrow(
    "Workflow tooling must preserve",
  );
});

const recordProof = (overrides: Record<string, string>, candidate = source) => {
  const directory = mkdtempSync(
    path.resolve(import.meta.dir, "../.staging-proof-test-"),
  );
  try {
    writeFileSync(path.join(directory, "status-writer.sh"), ":\n");
    const script = text(
      stepNamed("Record staging verification", candidate),
      "run",
    );
    const result = Bun.spawnSync(
      [
        "bash",
        "-c",
        `gh() { cat >/dev/null; }; export -f gh\n${script}\nprintf '%s|%s' "$state" "$description"`,
      ],
      {
        env: {
          PATH: process.env["PATH"] ?? "",
          GH_RETRY_SCRIPT: path.resolve(import.meta.dir, "gh-retry.sh"),
          GITHUB_REPOSITORY: "stella/stella",
          GITHUB_RUN_ID: "1",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
          STAGING_STATUS_WRITER: path.join(directory, "status-writer.sh"),
          DEPLOYMENT_ID: "1",
          DEPLOY_SHA: "a".repeat(40),
          PROOF_READINESS: "ready",
          PROOF_ENVIRONMENT: "ready",
          WEB_SMOKE: "success",
          API_SMOKE: "success",
          DEPLOYED_JOURNEYS: "success",
          MOCK_JOURNEYS: "success",
          JOB_STATUS: "success",
          CORPUS_PREFLIGHT: "failure",
          MCP_SMOKE: "skipped",
          CORPUS_SEARCH_WAIVED: "true",
          WAIVE_REASON: "Verification deferred; evidence=artifacts/check.log",
          ...overrides,
        },
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("environment conclusions remain errors before any named waiver is considered", () => {
  expect(recordProof({})).toStartWith("success|waived:");
  for (const status of ["environment-unavailable"]) {
    expect(recordProof({ PROOF_READINESS: status })).toStartWith(
      "error|Staging environment unavailable; rerun proof:",
    );
  }
  for (const status of ["", "environment-interrupted"]) {
    expect(recordProof({ PROOF_ENVIRONMENT: status })).toStartWith(
      "error|Staging environment interrupted; rerun proof:",
    );
  }
  const mutated = source.replace(
    '"$PROOF_READINESS" != "ready"',
    '"ready" != "ready"',
  );
  expect(mutated).not.toBe(source);
  expect(
    recordProof({ PROOF_READINESS: "environment-unavailable" }, mutated),
  ).toStartWith("success|waived:");
  expect(recordProof({ PROOF_READINESS: "" })).toStartWith("error|");
});

test("proof tooling failures remain distinct before waiver evaluation", () => {
  for (const overrides of [
    { PROOF_READINESS: "proof-tooling-failure" },
    { PROOF_ENVIRONMENT: "proof-tooling-failure" },
    { PROOF_READINESS: "" },
  ]) {
    const result = recordProof(overrides);
    expect(result).toStartWith("error|Staging proof tooling failure:");
    expect(result).not.toContain("rerun");
    expect(result).not.toContain("waived:");
  }
});

const workflowJobs = () => {
  const workflow: unknown = Bun.YAML.parse(source);
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
    throw new TypeError("Workflow jobs are required");
  }
  return workflow["jobs"];
};

test("mock-model journeys run alongside promotion for the same eligible commit with only Docker Hub secrets", () => {
  const jobs = workflowJobs();
  const promotion = jobs["promote-staging"];
  const journeys = jobs["mock-model-journeys"];
  if (
    !isRecord(promotion) ||
    !isRecord(journeys) ||
    !Array.isArray(journeys["steps"])
  ) {
    throw new TypeError("Both staging jobs are required");
  }
  expect(journeys["needs"]).toEqual(promotion["needs"]);
  expect(journeys["if"]).toBe(promotion["if"]);
  expect(promotion["needs"]).not.toContain("mock-model-journeys");
  expect(journeys["environment"]).toBeUndefined();
  const serialized = JSON.stringify(journeys);
  const secrets = [...serialized.matchAll(/secrets\.([A-Z_]+)/gu)].map(
    (match) => match[1],
  );
  expect(secrets.toSorted()).toEqual(["DOCKERHUB_TOKEN", "DOCKERHUB_USERNAME"]);
  const steps = journeys["steps"].filter(isRecord);
  const checkout = steps.find(
    (step) => step["name"] === "Checkout journey source",
  );
  const run = steps.find((step) => step["id"] === "mock-journeys");
  expect(checkout?.["with"]).toMatchObject({
    ref: `\${{ needs.resolve.outputs.sha }}`,
  });
  expect(run?.["uses"]).toBe("./.github/actions/user-journeys");
  expect(run?.["with"]).toMatchObject({
    project: "local-stack",
    "expected-commit": `\${{ needs.resolve.outputs.sha }}`,
  });
  expect(
    steps.find((step) => step["uses"] === "./.github/actions/user-journeys"),
  ).toBe(run);
  expect(
    promotionSteps().some(
      (step) =>
        isRecord(step["with"]) && step["with"]["project"] === "local-stack",
    ),
  ).toBe(false);
  expect(journeys["name"]).toBe("Mock-model application journeys");
  const barrier = stepNamed("Require mock-model journey success");
  expect(barrier["id"]).toBe("mock-journeys");
  expect(stepNamed("Record staging verification")["env"]).toMatchObject({
    MOCK_JOURNEYS: `\${{ steps.mock-journeys.outcome }}`,
    DEPLOY_SHA: `\${{ needs.resolve.outputs.sha }}`,
  });
});

const runJourneyBarrier = (responses: readonly string[]) => {
  const directory = mkdtempSync(
    path.resolve(import.meta.dir, "../.staging-journey-barrier-"),
  );
  try {
    const helper = path.join(directory, "api.sh");
    writeFileSync(
      path.join(directory, "responses.json"),
      JSON.stringify(responses),
    );
    writeFileSync(
      helper,
      `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "api --paginate --slurp repos/stella/stella/actions/runs/7/attempts/2/jobs?per_page=100" ]] || exit 2
counter_file="$BARRIER_DIRECTORY/counter"
count=0
if [[ -f "$counter_file" ]]; then count="$(cat "$counter_file")"; fi
jq -er --argjson index "$count" '.[$index] // error("No response")' "$BARRIER_DIRECTORY/responses.json"
echo "$((count + 1))" > "$counter_file"
`,
    );
    const result = Bun.spawnSync(
      [
        "bash",
        "-c",
        `sleep() { :; }; export -f sleep
${text(stepNamed("Require mock-model journey success"), "run")}`,
      ],
      {
        env: {
          PATH: process.env["PATH"] ?? "",
          GH_RETRY_SCRIPT: helper,
          GITHUB_REPOSITORY: "stella/stella",
          GITHUB_RUN_ID: "7",
          GITHUB_RUN_ATTEMPT: "2",
          BARRIER_DIRECTORY: directory,
        },
      },
    );
    return {
      code: result.exitCode,
      stderr: result.stderr.toString(),
      stdout: result.stdout.toString(),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
const journeyResponse = (status: string, conclusion: string | null) =>
  JSON.stringify([
    {
      jobs: [
        {
          name: "Mock-model application journeys",
          status,
          conclusion,
        },
      ],
    },
  ]);

test("verification's locked barrier requires the current run attempt's completed successful journey job", () => {
  expect(
    runJourneyBarrier([journeyResponse("completed", "success")]).code,
  ).toBe(0);
  expect(
    runJourneyBarrier([
      journeyResponse("queued", null),
      journeyResponse("in_progress", null),
      journeyResponse("completed", "success"),
    ]).code,
  ).toBe(0);
  for (const conclusion of [
    "failure",
    "cancelled",
    "skipped",
    "timed_out",
    "neutral",
    null,
  ]) {
    const result = runJourneyBarrier([
      journeyResponse("completed", conclusion),
    ]);
    expect(result.code, JSON.stringify({ conclusion, ...result })).not.toBe(0);
  }
  for (const response of [
    "invalid",
    JSON.stringify([{ jobs: [] }]),
    JSON.stringify([
      {
        jobs: [
          {
            name: "Mock-model application journeys",
            status: "completed",
            conclusion: "success",
          },
          {
            name: "Mock-model application journeys",
            status: "completed",
            conclusion: "failure",
          },
        ],
      },
    ]),
  ]) {
    expect(runJourneyBarrier([response]).code).not.toBe(0);
  }
  for (const outcome of ["failure", "skipped", "cancelled", ""]) {
    expect(recordProof({ MOCK_JOURNEYS: outcome })).toStartWith("failure|");
  }
});
