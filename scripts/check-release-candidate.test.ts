import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const subject = new URL("check-release-candidate.sh", import.meta.url).pathname;
const withCandidate = (
  verify: (
    root: string,
    sha: string,
    run: (
      sha: string,
      verifierExit?: string,
      trusted?: boolean,
    ) => ReturnType<typeof Bun.spawnSync>,
  ) => void,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "release-candidate-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    git("init", "-q", "--template=");
    git("config", "user.name", "fixture");
    git("config", "user.email", "fixture@example.test");
    git("config", "commit.gpgsign", "false");
    git("config", "tag.gpgsign", "false");
    writeFileSync(path.join(root, "VERSION"), "1.2.3\n");
    git("add", "VERSION");
    git("commit", "-qm", "cut base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("switch", "-qc", "release/v1.2.4");
    writeFileSync(path.join(root, "VERSION"), "1.2.4\n");
    git("add", "VERSION");
    git("commit", "-qm", "chore: release v1.2.4");
    const sha = git("rev-parse", "HEAD");
    writeFileSync(
      path.join(root, "verify.sh"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$CALLS"\nexit "$VERIFIER_EXIT"\n',
    );
    const run = (requested: string, verifierExit = "0", trusted = true) =>
      Bun.spawnSync(["bash", subject, requested], {
        cwd: root,
        env: {
          ...process.env,
          RELEASE_PROOF_REPOSITORY: trusted ? "stella/stella" : "",
          RELEASE_TREE_PROOF_VERIFIER: path.join(root, "verify.sh"),
          VERIFIER_EXIT: verifierExit,
          CALLS: path.join(root, "calls"),
        },
      });
    verify(root, sha, run);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("an exact open release PR head is accepted without main ancestry", () =>
  withCandidate((root, sha, run) => {
    const result = run(sha);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe(
      `sha=${sha}\nvalue=1.2.4\ntag=v1.2.4\n`,
    );
    expect(readFileSync(path.join(root, "calls"), "utf-8")).toBe(
      `--allow-pr-head stella/stella ${sha} ${sha}\n`,
    );
  }));

test("unverified or stale PR heads are refused before any candidate output", () =>
  withCandidate((_root, sha, run) => {
    for (const result of [run(sha, "1"), run(sha, "0", false)]) {
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toBe("");
    }
  }));

test("a final tag refuses a new RC even when its head still verifies", () =>
  withCandidate((root, sha, run) => {
    expect(
      Bun.spawnSync(["git", "tag", "v1.2.4", sha], { cwd: root }).exitCode,
    ).toBe(0);
    const result = run(sha);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "Release tag v1.2.4 already exists",
    );
  }));

test("symbolic refs, abbreviated SHAs and implicit main selection are refused", () =>
  withCandidate((_root, sha, run) => {
    for (const requested of [
      "main",
      sha.slice(0, 12),
      "--version-commit",
      "",
    ]) {
      const result = run(requested);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
    }
  }));

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
test("staging and heavy run the trusted candidate checker before source execution for explicit RC dispatches", () => {
  for (const [name, job] of [
    ["deploy-staging", "resolve"],
    ["main-heavy", "validate"],
  ]) {
    const workflow: unknown = Bun.YAML.parse(
      readFileSync(
        new URL(`../.github/workflows/${name}.yml`, import.meta.url),
        "utf-8",
      ),
    );
    const steps = field(field(field(workflow, "jobs"), job ?? ""), "steps");
    expect(Array.isArray(steps)).toBe(true);
    const step: unknown = Array.isArray(steps)
      ? steps.find(
          (value) => field(value, "name") === "Check release candidate",
        )
      : undefined;
    expect(field(step, "name")).toBe("Check release candidate");
    expect(field(step, "if")).toContain("inputs.release_candidate == true");
    expect(field(step, "continue-on-error")).toBeUndefined();
    const script = String(field(step, "run"));
    expect(script).toContain(
      "fetch --tags origin main:refs/remotes/origin/main",
    );
    expect(script).toContain(
      "show origin/main:scripts/check-release-candidate.sh",
    );
    expect(script).toContain(
      'bash "$RUNNER_TEMP/check-release-candidate.sh" "$REQUESTED_SHA"',
    );
  }
});

test("tag preparation shares the PR-head identity owner", () => {
  const source = readFileSync(
    new URL("prepare-release-tag.sh", import.meta.url),
    "utf-8",
  );
  expect(source).toContain(
    'RELEASE_PROOF_REPOSITORY="$repo" RELEASE_TREE_PROOF_VERIFIER="$tree_proof_verifier" bash "$script_dir/check-release-candidate.sh" "$sha"',
  );
  expect(source).not.toContain("--version-commit");
});
