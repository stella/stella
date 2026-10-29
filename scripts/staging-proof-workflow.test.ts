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
  "Run mock-model application journeys",
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
