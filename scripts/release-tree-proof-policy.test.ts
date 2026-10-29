import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf-8");
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
const steps = (workflow: unknown, job: string): unknown[] => {
  const value = field(field(field(workflow, "jobs"), job), "steps");
  return Array.isArray(value) ? value : [];
};
const runs = (workflow: unknown, job: string) =>
  steps(workflow, job)
    .map((step) => field(step, "run"))
    .filter((run) => typeof run === "string")
    .join("\n");

const dispatcherProblems = (source: string) => {
  const workflow: unknown = Bun.YAML.parse(source);
  const dispatch = steps(workflow, "dispatch");
  const problems: string[] = [];
  const checkout = dispatch.find((step) =>
    String(field(step, "uses")).startsWith("actions/checkout@"),
  );
  if (field(field(checkout, "with"), "ref") !== "main") {
    problems.push("trusted main checkout required");
  }
  const script = runs(workflow, "dispatch");
  const verification = script.indexOf(
    "bash scripts/verify-release-tree-proof.sh --allow-pr-head",
  );
  const tag = script.indexOf("workflow run release-tag.yml");
  if (verification === -1 || tag <= verification) {
    problems.push("verify before RC dispatch");
  }
  if (!script.includes('--ref main -f mode=rc -f sha="$PROOF_SHA"')) {
    problems.push("pin RC dispatch to PR SHA");
  }
  if (/workflow run (?:deploy-staging|main-heavy)/u.test(script)) {
    problems.push("proof dispatch belongs to artifact run");
  }
  return problems;
};
test("release proof verifies trusted PR head before dispatching only its RC tag", () => {
  const source = read(".github/workflows/release-proof.yml");
  expect(dispatcherProblems(source)).toEqual([]);
  for (const changed of [
    source.replace("ref: main", "ref: contributor"),
    source.replace(
      "bash scripts/verify-release-tree-proof.sh",
      "bash scripts/unverified.sh",
    ),
    source.replace('-f sha="$PROOF_SHA"', "-f sha=main"),
  ]) {
    expect(changed).not.toBe(source);
    expect(dispatcherProblems(changed).length).toBeGreaterThan(0);
  }
});

test("PR-head proof validates the complete release delta from its merge-base with main", () => {
  const source = read("scripts/verify-release-tree-proof.sh");
  const branch = source.slice(source.indexOf("  release_version=$(git show"));
  expect(branch).toContain('main=$(git merge-base "$sha" origin/main)');
  expect(branch).toContain(
    'node "$candidate_tree_verifier" "$main" "$proof" "$repo"',
  );
  expect(branch).not.toContain('git merge-base --is-ancestor "$main" "$proof"');
  expect(branch).not.toContain("RELEASE_TREE_PROOF_STALE");
  expect(branch).not.toContain("release candidate must have one parent");
});

test("RC selection verifies the open release relation and finalization uses exact-SHA health", () => {
  const source: unknown = Bun.YAML.parse(
    read(".github/workflows/release-tag.yml"),
  );
  const selection = runs(source, "tag");
  const finalize = runs(source, "finalize");
  expect(selection).toContain("scripts/prepare-release-tag.sh");
  expect(selection).not.toContain("--candidate-only");
  expect(selection).not.toContain("check-release-main-health.sh");
  const selector = read("scripts/prepare-release-tag.sh");
  expect(selector).toContain("check-release-candidate.sh");
  expect(selector).toContain("release-rc-number.sh");
  expect(selector).not.toMatch(/--candidate-only|--proof-sha/u);
  expect(selector).not.toMatch(
    /--find-proof|statuses\?|check-release-main-health|check-release-receipt-coverage/u,
  );
  expect(selection).toContain("check-release-rc-source.sh");
  expect(selection).toContain("release-rc-number.sh");
  expect(finalize).toContain(
    'bash scripts/finalize-release.sh "$GITHUB_REPOSITORY" "$RELEASE_SHA"',
  );
  expect(finalize).not.toMatch(/bun ci|bun install|npm install/u);
  const finalizer = read("scripts/finalize-release.sh");
  expect(finalizer).toContain(
    'check-release-main-health.sh" "$repo" "$sha" "$sha"',
  );
  expect(finalizer.indexOf("check-release-main-health.sh")).toBeLessThan(
    finalizer.indexOf('git tag -a "$final"'),
  );
});

test("a release merge has no tag or branch-refresh jobs", () => {
  const source: unknown = Bun.YAML.parse(
    read(".github/workflows/release-pr.yml"),
  );
  const jobs = field(source, "jobs");
  expect(field(jobs, "tag-version")).toBeUndefined();
  for (const job of [
    "refresh-release-plan",
    "refresh-release-stage",
    "refresh-release-version",
  ]) {
    expect(field(jobs, job)).toBeUndefined();
  }
});

test("autofix cannot rewrite release branches on PR or manual requests", () => {
  const source = read(".github/workflows/autofix.yml");
  expect(source).toContain(
    "!startsWith(github.event.pull_request.head.ref, 'release/v')",
  );
  expect(source).toContain('.head.ref | startswith("release/v")');
});

test("release branches prohibit deletion and force pushes", () => {
  const ruleset: unknown = JSON.parse(
    read(".github/branch-protection/ruleset-release.json"),
  );
  expect(
    field(field(field(ruleset, "conditions"), "ref_name"), "include"),
  ).toEqual(["refs/heads/release/v*"]);
  const rules = field(ruleset, "rules");
  expect(
    Array.isArray(rules) ? rules.map((rule) => field(rule, "type")) : [],
  ).toEqual(["deletion", "non_fast_forward"]);
});
