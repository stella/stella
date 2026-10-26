import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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
  coverage: string;
};
const policyProblems = ({
  staging,
  release,
  prepare,
  health,
  coverage,
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
    // The merge-group receipt has one owner: the shared verifier, reached
    // only through the coverage check that also enforces queue history.
    if (
      !/bash\s+"[^"\n]*\/check-release-receipt-coverage\.sh"\s+"\$repo"/u.test(
        source,
      ) ||
      /--merge-group-receipt|check-runs/u.test(source)
    ) {
      problems.push(
        `${name} must read the receipt through the shared verifier`,
      );
    }
  }
  const coverageSource = activeShell(coverage);
  if (
    !/bash\s+"\$tree_proof_verifier"\s+--merge-group-receipt\s+"\$repo"/u.test(
      coverageSource,
    ) ||
    !coverageSource.includes("RELEASE_TREE_PROOF_VERIFIER") ||
    /check-runs/u.test(coverageSource)
  ) {
    problems.push("coverage must read the receipt through the shared verifier");
  }
  if (
    !/bun\s+"\$queue_history"\s+--require(?:\s|$)/u.test(coverageSource) ||
    !coverageSource.includes(
      'queue_history="$script_dir/check-release-queue-history.ts"',
    )
  ) {
    problems.push("coverage must enforce the strict queue history check");
  }
  const releaseWorkflow: unknown = Bun.YAML.parse(release);
  if (field(field(releaseWorkflow, "permissions"), "checks") !== "read") {
    problems.push("release must be able to read the merge-group receipt");
  }
  const steps = workflowSteps(release);
  // Both the candidate selection and the release evidence gate run the
  // verified selector.
  for (const [id, part] of [
    ["candidate", "selection"],
    ["evidence", "evidence"],
  ] as const) {
    if (
      !steps.some(
        (step) =>
          step.id === id &&
          /bash\s+scripts\/prepare-release-tag\.sh(?:\s|$)/u.test(step.run),
      )
    ) {
      problems.push(`release ${part} must use the verified candidate selector`);
    }
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
  for (const guard of [
    "check-release-receipt-coverage.sh",
    "check-release-queue-history.ts",
  ]) {
    const preserved = steps.findIndex(({ run }) =>
      run.includes(`cp scripts/${guard} "$RUNNER_TEMP/${guard}"`),
    );
    if (preserved === -1 || checkout === -1 || preserved >= checkout) {
      problems.push(`release must preserve ${guard} before candidate checkout`);
    }
  }
  // Selection already applies the queue history rule, so Bun comes first.
  const setupBun = steps.findIndex(
    ({ uses }) =>
      typeof uses === "string" && uses.includes("/setup-bun-cached@"),
  );
  const selection = steps.findIndex(({ run }) =>
    run.includes("bash scripts/prepare-release-tag.sh"),
  );
  if (setupBun === -1 || selection === -1 || setupBun >= selection) {
    problems.push("release must set up Bun before selecting the candidate");
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
  coverage: read("scripts/check-release-receipt-coverage.sh"),
};

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
  if (!script.includes('if [[ "$verified" -eq 3 ]]; then')) {
    problems.push(
      "dispatcher must skip, not fail, when main moved past the head",
    );
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

test("the merge-group receipt is read only through the shared verifier", () => {
  for (const name of ["prepare", "health"] as const) {
    for (const mutated of [
      sources[name].replaceAll(
        "check-release-receipt-coverage.sh",
        "unverified-receipt.sh",
      ),
      `${sources[name]}\nbash "$tree_proof_verifier" --merge-group-receipt "$repo" "$sha"\n`,
      `${sources[name]}\ngh api "repos/$repo/commits/$sha/check-runs"\n`,
    ]) {
      expect(mutated).not.toBe(sources[name]);
      expect(policyProblems({ ...sources, [name]: mutated })).toContain(
        `${name} must read the receipt through the shared verifier`,
      );
    }
  }
  for (const coverage of [
    sources.coverage.replaceAll(
      "--merge-group-receipt",
      "--unverified-receipt",
    ),
    `${sources.coverage}\ngh api "repos/$repo/commits/$sha/check-runs"\n`,
  ]) {
    expect(coverage).not.toBe(sources.coverage);
    expect(policyProblems({ ...sources, coverage })).toContain(
      "coverage must read the receipt through the shared verifier",
    );
  }
  const advisory = sources.coverage.replace(
    'bun "$queue_history" --require',
    'bun "$queue_history"',
  );
  expect(advisory).not.toBe(sources.coverage);
  expect(policyProblems({ ...sources, coverage: advisory })).toContain(
    "coverage must enforce the strict queue history check",
  );
  const release = sources.release.replace("  checks: read\n", "");
  expect(release).not.toBe(sources.release);
  expect(policyProblems({ ...sources, release })).toContain(
    "release must be able to read the merge-group receipt",
  );
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
    sources.release.replace(
      'cp scripts/check-release-queue-history.ts "$RUNNER_TEMP/check-release-queue-history.ts"',
      "true",
    ),
    sources.release.replace(
      'cp scripts/check-release-receipt-coverage.sh "$RUNNER_TEMP/check-release-receipt-coverage.sh"',
      "true",
    ),
  ];
  for (const release of mutations) {
    expect(release).not.toBe(sources.release);
    expect(policyProblems({ ...sources, release }).length).toBeGreaterThan(0);
  }
});
