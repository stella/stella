import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf-8");
const verifier = "verify-release-tree-proof.sh";
const activeShell = (script: string) =>
  script
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

const workflowSteps = (source: string) => {
  const workflow: unknown = Bun.YAML.parse(source);
  if (typeof workflow !== "object" || workflow === null) {
    return [];
  }
  const jobs: unknown = Reflect.get(workflow, "jobs");
  if (typeof jobs !== "object" || jobs === null) {
    return [];
  }
  return Object.values(jobs).flatMap((job: unknown) => {
    if (typeof job !== "object" || job === null) {
      return [];
    }
    const steps: unknown = Reflect.get(job, "steps");
    if (!Array.isArray(steps)) {
      return [];
    }
    return steps.flatMap((step: unknown) => {
      if (typeof step !== "object" || step === null) {
        return [];
      }
      const run: unknown = Reflect.get(step, "run");
      const env: unknown = Reflect.get(step, "env");
      const preservedVerifier: unknown =
        typeof env === "object" && env !== null
          ? Reflect.get(env, "RELEASE_TREE_PROOF_VERIFIER")
          : undefined;
      return [
        {
          run: typeof run === "string" ? activeShell(run) : "",
          preservedVerifier,
          id: field(step, "id"),
          condition: field(step, "if"),
          workingDirectory: field(step, "working-directory"),
          uses: field(step, "uses"),
          ref: field(field(step, "with"), "ref"),
          path: field(field(step, "with"), "path"),
          actionScript: field(field(step, "with"), "script"),
          reuseRun: field(env, "REUSE_RUN"),
        },
      ];
    });
  });
};

type ReleaseProofSources = {
  staging: string;
  release: string;
  prepare: string;
  health: string;
};
const policyProblems = ({
  staging,
  release,
  prepare,
  health,
}: ReleaseProofSources) => {
  const problems: string[] = [];
  const stagingRuns = workflowSteps(staging)
    .map(({ run }) => run)
    .join("\n");
  if (
    !/bash\s+scripts\/verify-release-tree-proof\.sh(?:\s|$)/u.test(stagingRuns)
  ) {
    problems.push("staging must invoke the shared verifier");
  }
  for (const [name, script] of Object.entries({ prepare, health })) {
    const source = activeShell(script);
    if (
      !source.includes(verifier) ||
      !/bash\s+"\$tree_proof_verifier"(?:\s|$)/u.test(source)
    ) {
      problems.push(`${name} must invoke the shared verifier`);
    }
    if (!source.includes("RELEASE_TREE_PROOF_VERIFIER")) {
      problems.push(`${name} must support the trusted verifier path`);
    }
  }
  const steps = workflowSteps(release);
  if (
    !steps.some(({ run }) =>
      /bash\s+scripts\/prepare-release-tag\.sh(?:\s|$)/u.test(run),
    )
  ) {
    problems.push("release selection must use the verified candidate selector");
  }
  const preserve = steps.findIndex(({ run }) =>
    run.includes(`cp scripts/${verifier} "$RUNNER_TEMP/${verifier}"`),
  );
  const checkout = steps.findIndex(({ run }) =>
    run.includes("git checkout --detach"),
  );
  if (preserve === -1 || checkout === -1 || preserve >= checkout) {
    problems.push(
      "release must preserve the trusted verifier before candidate checkout",
    );
  }
  const push = steps.find(({ run }) => run.includes("git push"));
  const healthCall =
    push?.run.indexOf('bash "$RUNNER_TEMP/check-release-main-health.sh"') ?? -1;
  const tagPush = push?.run.indexOf("git push") ?? -1;
  if (healthCall < 0 || healthCall >= tagPush) {
    problems.push(
      "release must recheck health using the preserved guard before push",
    );
  }
  if (push?.preservedVerifier !== `\${{ runner.temp }}/${verifier}`) {
    problems.push("release pre-push guard must use the preserved verifier");
  }
  return problems;
};

const sources = {
  staging: read(".github/workflows/deploy-staging.yml"),
  release: read(".github/workflows/release-tag.yml"),
  prepare: read("scripts/prepare-release-tag.sh"),
  health: read("scripts/check-release-main-health.sh"),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const releaseJobs = (source: string) => {
  const workflow: unknown = Bun.YAML.parse(source);
  const jobs = field(workflow, "jobs");
  assert.ok(isRecord(jobs), "Release workflow must declare jobs");
  return Object.fromEntries(
    Object.entries(jobs).map(([id, job]) => {
      assert.ok(isRecord(job), `Release job ${id} must be an object`);
      return [id, job] as const;
    }),
  );
};

const stepReferenceCensus = (source: string) =>
  Object.entries(releaseJobs(source)).flatMap(([jobId, job]) => {
    const ids = new Set(
      job["steps"] === undefined
        ? []
        : workflowJobSteps({ jobs: { [jobId]: job } }, jobId).map(
            (step) => step["id"],
          ),
    );
    const references: { jobId: string; stepId: string; local: boolean }[] = [];
    const visit = (value: unknown) => {
      if (typeof value === "string") {
        for (const match of value.matchAll(
          /\bsteps(?:\.([\w-]+)|\[\s*'([^']+)'\s*\])/gu,
        )) {
          const stepId = match[1] ?? match[2];
          if (stepId !== undefined) {
            references.push({ jobId, stepId, local: ids.has(stepId) });
          }
        }
        return;
      }
      if (typeof value === "object" && value !== null) {
        for (const child of Object.values(value)) {
          visit(child);
        }
      }
    };
    visit(job);
    return references;
  });

test("every release step reference belongs to its own job", () => {
  const references = stepReferenceCensus(sources.release);
  expect(references.length).toBeGreaterThan(0);
  for (const reference of references) {
    expect(reference).toEqual({ ...reference, local: true });
  }
});

test("the release reference census rejects every missing local step", () => {
  for (const { jobId, stepId } of stepReferenceCensus(sources.release)) {
    const jobs = releaseJobs(sources.release);
    const steps = workflowJobSteps({ jobs }, jobId);
    const step = steps.find((candidate) => candidate["id"] === stepId);
    assert.ok(step !== undefined, `Missing local step ${jobId}.${stepId}`);
    delete step["id"];
    expect(stepReferenceCensus(Bun.YAML.stringify({ jobs }))).toContainEqual({
      jobId,
      stepId,
      local: false,
    });
  }
});

const resolveReleaseExpression = (expression: unknown, context: unknown) => {
  assert.ok(
    typeof expression === "string",
    "Release expression must be a string",
  );
  const path = expression.match(/^\$\{\{\s*([\w.-]+)\s*\}\}$/u)?.[1];
  assert.ok(path !== undefined, "Expected a release output reference");
  let value = context;
  for (const key of path.split(".")) {
    value = field(value, key);
  }
  assert.ok(typeof value === "string", `Unresolved release reference: ${path}`);
  return value;
};

test("a nonempty dispatched proof reaches the final tag health guard through candidate job outputs", () => {
  const workflow: unknown = Bun.YAML.parse(sources.release);
  const jobs = releaseJobs(sources.release);
  const select = workflowStepByName(
    workflowJobSteps(workflow, "candidate"),
    "Select and validate the release commit",
  );
  const proof = "a".repeat(40);
  const selectedProof = resolveReleaseExpression(
    field(select["env"], "PROOF_SHA"),
    { inputs: { proof_sha: proof } },
  );
  expect(select["run"]).toContain('--proof-sha "$PROOF_SHA"');
  const candidateProof = resolveReleaseExpression(
    field(jobs["candidate"]?.["outputs"], "proof-sha"),
    { steps: { candidate: { outputs: { "proof-sha": selectedProof } } } },
  );
  const push = workflowStepByName(
    workflowJobSteps(workflow, "tag"),
    "Push tag",
  );
  expect(jobs["tag"]?.["needs"]).toContain("candidate");
  const tagProof = resolveReleaseExpression(field(push["env"], "PROOF_SHA"), {
    needs: { candidate: { outputs: { "proof-sha": candidateProof } } },
  });
  const run = push["run"];
  assert.ok(typeof run === "string", "Push tag must declare a shell command");
  const result = Bun.spawnSync(
    ["bash", "-c", `bash() { printf '%s\\n' "$4"; }; git() { :; }; ${run}`],
    { env: { PROOF_SHA: tagProof } },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe(proof);
});

test("every release gate uses the shared tree proof verifier", () => {
  expect(policyProblems(sources)).toEqual([]);
});

const dispatcherProblems = (source: string) => {
  const problems: string[] = [];
  const steps = workflowSteps(source);
  const checkouts = steps.filter(
    ({ uses }) =>
      typeof uses === "string" && uses.startsWith("actions/checkout@"),
  );
  if (checkouts.length !== 1 || checkouts.at(0)?.ref !== "main") {
    problems.push("dispatcher must checkout trusted main only");
  }
  const dispatch = steps.find(({ run }) => run.includes("gh workflow run"));
  const checkout = checkouts.at(0);
  if (
    !checkout ||
    !dispatch ||
    steps.indexOf(checkout) >= steps.indexOf(dispatch)
  ) {
    problems.push("trusted checkout must precede dispatch");
  }
  const script = dispatch?.run ?? "";
  const verification = script.indexOf(
    "bash scripts/verify-release-tree-proof.sh --allow-pr-head",
  );
  if (
    verification === -1 ||
    verification >= script.indexOf("gh workflow run")
  ) {
    problems.push("dispatcher must verify the PR chain before dispatch");
  }
  if (
    !script.includes("for workflow in deploy-staging main-heavy; do") ||
    !script.includes('--ref main -f sha="$PROOF_SHA" -f release_candidate=true')
  ) {
    problems.push(
      "dispatcher must pin both trusted workflows to the verified head",
    );
  }
  return problems;
};

test("release proof dispatcher executes trusted main and verifies before both pinned dispatches", () => {
  const source = read(".github/workflows/release-proof.yml");
  expect(dispatcherProblems(source)).toEqual([]);
  for (const changed of [
    source.replace(
      "ref: main",
      `ref: \${{ github.event.pull_request.head.sha }}`,
    ),
    source.replace(
      "bash scripts/verify-release-tree-proof.sh",
      "bash scripts/unverified-proof.sh",
    ),
    source.replace("deploy-staging main-heavy", "deploy-staging"),
    source.replace(
      '--ref main -f sha="$PROOF_SHA"',
      '--ref "$PROOF_SHA" -f sha="$PROOF_SHA"',
    ),
  ]) {
    expect(changed).not.toBe(source);
    expect(dispatcherProblems(changed).length).toBeGreaterThan(0);
  }
});

const reuseProblems = (source: string) => {
  const problems: string[] = [];
  const steps = workflowSteps(source);
  const reuse = steps.find(({ id }) => id === "reuse");
  const trusted = steps.find(
    ({ path, ref }) => path === ".release-proof" && ref === "main",
  );
  if (
    !trusted ||
    !reuse ||
    reuse.workingDirectory !== ".release-proof" ||
    steps.indexOf(trusted) >= steps.indexOf(reuse)
  ) {
    problems.push("reuse must execute health tooling from trusted main");
  }
  const script = reuse?.run ?? "";
  const health = script.indexOf("bash scripts/check-release-main-health.sh");
  const skip = script.indexOf('echo "run=false"');
  if (
    health === -1 ||
    skip === -1 ||
    health >= skip ||
    !script.includes("set -euo pipefail")
  ) {
    problems.push("reuse may skip only after the health gate succeeds");
  }
  const blockingHealth = [
    "set -euo pipefail",
    'if proof=$(bash scripts/verify-release-tree-proof.sh --find-proof "$GITHUB_REPOSITORY" "$SHA") && [[ -n "$proof" ]]; then',
    'if bash scripts/check-release-main-health.sh "$GITHUB_REPOSITORY" "$SHA" "$proof"; then',
    'echo "proof=$proof" >> "$GITHUB_OUTPUT"',
    'echo "run=false" >> "$GITHUB_OUTPUT"',
    "else",
    'echo "run=true" >> "$GITHUB_OUTPUT"',
    "fi",
    "fi",
  ].join("\n");
  const normalized = script
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  if (
    !script.includes(
      'proof=$(bash scripts/verify-release-tree-proof.sh --find-proof "$GITHUB_REPOSITORY" "$SHA")',
    ) ||
    normalized !== blockingHealth
  ) {
    problems.push(
      "proof reuse must force fresh gates only for a failed identified proof",
    );
  }
  const selection = steps.find(({ id }) => id === "selection");
  if (selection?.condition !== "steps.reuse.outputs.run != 'false'") {
    problems.push("successful reuse must suppress selection");
  }
  const freshSelection = [
    'if (process.env.REUSE_RUN === "true") {',
    'core.setOutput("run", "true");',
    "return;",
    "}",
  ].join("\n");
  const selectionScript =
    typeof selection?.actionScript === "string"
      ? selection.actionScript
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .join("\n")
      : "";
  if (
    selection?.reuseRun !== `\${{ steps.reuse.outputs.run }}` ||
    !selectionScript.startsWith(freshSelection)
  ) {
    problems.push(
      "failed identified proof validation must force fresh gates before historical status selection",
    );
  }
  const workflow: unknown = Bun.YAML.parse(source);
  const jobs = field(workflow, "jobs");
  const proofOutput = field(field(field(jobs, "validate"), "outputs"), "proof");
  const publicationCondition = field(field(jobs, "status"), "if");
  if (
    proofOutput !== `\${{ steps.reuse.outputs.proof }}` ||
    publicationCondition !==
      "always() && needs.validate.result != 'skipped' && needs.validate.outputs.run != 'false' && !needs.validate.outputs.proof"
  ) {
    problems.push(
      "successful proof reuse must suppress target status publication",
    );
  }
  return problems;
};

test("main proof workflows skip through the trusted successful health gate", () => {
  for (const workflow of ["main-heavy", "main-pr-depth"]) {
    const source = read(`.github/workflows/${workflow}.yml`);
    expect(reuseProblems(source)).toEqual([]);
    for (const changed of [
      source.replace(
        "bash scripts/check-release-main-health.sh",
        "bash scripts/unverified-health.sh",
      ),
      source.replace(
        "working-directory: .release-proof",
        "working-directory: .",
      ),
      source.replace("if: steps.reuse.outputs.run != 'false'", "if: always()"),
      source.replace(
        'bash scripts/check-release-main-health.sh "$GITHUB_REPOSITORY" "$SHA" "$proof"; then',
        'bash scripts/check-release-main-health.sh "$GITHUB_REPOSITORY" "$SHA" "$proof" || true; then',
      ),
      source.replace(
        "bash scripts/verify-release-tree-proof.sh --find-proof",
        "bash scripts/unverified-proof.sh --find-proof",
      ),
      source.replace(" && !needs.validate.outputs.proof", ""),
      source.replace(`proof: \${{ steps.reuse.outputs.proof }}`, "proof: ''"),
      source.replace('echo "proof=$proof" >> "$GITHUB_OUTPUT"', "true"),
      source.replace(
        'echo "run=true" >> "$GITHUB_OUTPUT"',
        'echo "run=false" >> "$GITHUB_OUTPUT"',
      ),
      source.replace(
        `REUSE_RUN: \${{ steps.reuse.outputs.run }}`,
        "REUSE_RUN: 'false'",
      ),
      source.replace(
        'process.env.REUSE_RUN === "true"',
        'process.env.REUSE_RUN === "false"',
      ),
      source.replace(' && [[ -n "$proof" ]]', ""),
      source.replace(
        "            fi\n          fi",
        () =>
          '            fi\n          else\n            echo "run=true" >> "$GITHUB_OUTPUT"\n          fi',
      ),
    ]) {
      expect(changed).not.toBe(source);
      expect(reuseProblems(changed).length).toBeGreaterThan(0);
    }
  }
});

test("removing verifier delegation from any release gate violates policy", () => {
  for (const name of ["staging", "prepare", "health"] as const) {
    const mutated = {
      ...sources,
      [name]: sources[name]
        .replaceAll(verifier, "unverified-proof.sh")
        .replaceAll('bash "$tree_proof_verifier"', 'bash "$unverified_proof"'),
    };
    expect(mutated[name]).not.toBe(sources[name]);
    expect(policyProblems(mutated)).toContain(
      `${name} must invoke the shared verifier`,
    );
  }
});

test("release checkout cannot replace the trusted pre-push verifier", () => {
  const mutations = [
    sources.release.replace(
      `cp scripts/${verifier} "$RUNNER_TEMP/${verifier}"`,
      "true",
    ),
    sources.release.replace(
      `\${{ runner.temp }}/${verifier}`,
      () => `scripts/${verifier}`,
    ),
    sources.release.replace(
      'bash "$RUNNER_TEMP/check-release-main-health.sh"',
      "bash scripts/check-release-main-health.sh",
    ),
    sources.release.replace(
      "bash scripts/prepare-release-tag.sh",
      "bash scripts/unverified-candidate.sh",
    ),
  ];
  for (const release of mutations) {
    expect(release).not.toBe(sources.release);
    expect(policyProblems({ ...sources, release }).length).toBeGreaterThan(0);
  }
});
