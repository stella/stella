import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const base = "a".repeat(40);
const candidate = "b".repeat(40);
const script = path.resolve(import.meta.dir, "rehearse-exact-base-upgrade.sh");

// Fake external processes exercise the orchestration without databases or a checkout.
const fakeGit = `#!/usr/bin/env bash
set -eu
if [[ -n "\${GRAPH_REPO:-}" ]]; then
  case "$3" in
    rev-parse|merge-base) exec "$REAL_GIT" -C "$GRAPH_REPO" "\${@:3}" ;;
  esac
fi
case "$3 $4" in
  "rev-parse HEAD") printf '%s\\n' "$FAKE_CANDIDATE" ;;
  "rev-parse --verify") printf '%s\\n' "$BASE_SHA" ;;
  "worktree add")
    if [[ -n "\${CHECKOUT_LOG:-}" ]]; then printf '%s\\n' "$7" > "$CHECKOUT_LOG"; fi
    mkdir -p "$6/apps/api" ;;
  "worktree remove") ;;
  *) exit 9 ;;
esac
`;
const fakeBun = `#!/usr/bin/env bash
set -eu
if [[ "$1" == "-e" ]]; then
  if [[ "$2" == *"new URL("* ]]; then
    printf '%s/%s\\n' "\${DATABASE_URL%/*}" "$3"
  fi
  exit 0
fi
case "$1" in
  ci) exit 0 ;;
  run)
    if [[ "$FAKE_OUTCOME" == "migration-infra" && "$2" == "src/db/migrate.ts" ]]; then
      exit 2
    fi
    exit 0 ;;
esac
case "$2" in
  assert-empty) exit 0 ;;
  snapshot) printf '{}\\n' ;;
  seed-footprint) printf 'public.seeded\\n' ;;
  digest)
    key="\${DATABASE_URL##*/}"
    file="$FAKE_STATE/$key"
    count=0
    if [[ -f "$file" ]]; then read -r count <"$file"; fi
    count=$(( count + 1 ))
    printf '%s\\n' "$count" >"$file"
    if [[ "$FAKE_OUTCOME" == "digest-drift" && "$count" == 2 ]]; then
      printf 'migrations=same constraints=same decisions=changed citations=same\\n'
    else
      printf 'migrations=same constraints=same decisions=same citations=same\\n'
    fi ;;
  compare)
    count=0
    if [[ -f "$FAKE_STATE/compare" ]]; then read -r count <"$FAKE_STATE/compare"; fi
    count=$(( count + 1 ))
    printf '%s\\n' "$count" >"$FAKE_STATE/compare"
    if [[ "$FAKE_OUTCOME" == "comparison-infra" ]]; then
      printf 'unreadable snapshot\\n' >&2
      exit 1
    fi
    if [[ "$FAKE_OUTCOME" == "catalog-drift" || ( "$FAKE_OUTCOME" == "rerun-drift" && "$count" == 2 ) ]]; then
      printf 'policies.public.items.read.qual: tenant != true\\n' >&2
      exit 2
    fi
    printf 'catalogs match\\n' ;;
  *) exit 9 ;;
esac
`;

for (const { outcome, exitCode, verdict, difference } of [
  { outcome: "pass", exitCode: 0, verdict: "pass", difference: null },
  {
    outcome: "catalog-drift",
    exitCode: 2,
    verdict: "drift found",
    difference: "policies.public.items.read.qual: tenant != true",
  },
  {
    outcome: "rerun-drift",
    exitCode: 2,
    verdict: "drift found",
    difference: "policies.public.items.read.qual: tenant != true",
  },
  {
    outcome: "digest-drift",
    exitCode: 2,
    verdict: "drift found",
    difference: "upgrade digest: decisions=same != decisions=changed",
  },
  {
    outcome: "comparison-infra",
    exitCode: 1,
    verdict: "infra failure",
    difference: null,
  },
  {
    outcome: "migration-infra",
    exitCode: 1,
    verdict: "infra failure",
    difference: null,
  },
  {
    outcome: "invalid-base",
    exitCode: 1,
    verdict: "infra failure",
    difference: null,
  },
]) {
  test(`rehearsal records ${outcome} with a distinct verdict and exit code`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), "exact-base-outcome-"));
    const summary = path.join(directory, "summary");
    try {
      for (const { name, contents } of [
        { name: "git", contents: fakeGit },
        { name: "bun", contents: fakeBun },
      ]) {
        const executable = path.join(directory, name);
        writeFileSync(executable, contents);
        chmodSync(executable, 0o700);
      }
      const run = Bun.spawnSync({
        cmd: ["bash", script],
        env: {
          PATH: `${directory}:${process.env["PATH"] ?? ""}`,
          RUNNER_TEMP: directory,
          GITHUB_STEP_SUMMARY: summary,
          BASE_SHA: outcome === "invalid-base" ? "invalid" : base,
          DATABASE_URL: "postgres://local@127.0.0.1:5432/stella",
          CLEAN_DATABASE_URL: "postgres://local@127.0.0.1:5433/stella",
          FAKE_CANDIDATE: candidate,
          FAKE_OUTCOME: outcome,
          FAKE_STATE: directory,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(exitCode);
      const report = readFileSync(summary, "utf-8");
      expect(report).toContain(`| Verdict | ${verdict} |`);
      expect(report).toContain(
        `| Base | \`${outcome === "invalid-base" ? "invalid" : base}\` |`,
      );
      expect(report).toContain(`| Candidate | \`${candidate}\` |`);
      for (const phase of [
        "Prepare",
        "Base migrate",
        "Base seed",
        "Candidate migrate",
        "Compare catalogs",
        "Rerun",
        "Compare rerun",
        "Total rehearsal",
      ]) {
        expect(report).toMatch(
          new RegExp(`\\| ${phase} \\| (?:\\d+s|not run) \\|`, "u"),
        );
      }
      if (difference !== null) {
        expect(report).toContain(`First difference: ${difference}`);
      } else {
        expect(report).not.toContain("First difference:");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const groupSize of [2, 3]) {
  for (const scenario of [
    "group-base",
    "unrelated-base",
    "mismatched-event",
  ] as const) {
    test(`multi-entry group of ${groupSize} PRs: ${scenario}`, () => {
      const directory = mkdtempSync(path.join(tmpdir(), "exact-base-history-"));
      const realGit = Bun.which("git");
      if (realGit === null) {
        throw new Error("Git is required for the multi-entry fixture");
      }
      try {
        const graphRepo = path.join(directory, "repo");
        mkdirSync(graphRepo);
        const git = (...args: string[]) => {
          const run = Bun.spawnSync({
            cmd: [realGit, "-C", graphRepo, ...args],
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "Fixture",
              GIT_AUTHOR_EMAIL: "fixture@example.test",
              GIT_COMMITTER_NAME: "Fixture",
              GIT_COMMITTER_EMAIL: "fixture@example.test",
            },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          });
          expect(run.exitCode, run.stderr.toString()).toBe(0);
          return run.stdout.toString().trim();
        };
        git("init", "--quiet");
        const tree = git("mktree");
        const groupBase = git("commit-tree", tree, "-m", "group base");
        const unrelated = git("commit-tree", tree, "-m", "unrelated base");
        let groupHead = groupBase;
        for (let entry = 1; entry <= groupSize; entry++) {
          groupHead = git(
            "commit-tree",
            tree,
            "-p",
            groupHead,
            "-m",
            `PR ${entry}`,
          );
        }
        git("update-ref", "HEAD", groupHead);
        const firstParent = git("rev-parse", "HEAD^1");
        expect(firstParent).not.toBe(groupBase);
        const suppliedBase = {
          "group-base": groupBase,
          "unrelated-base": unrelated,
          "mismatched-event": firstParent,
        }[scenario];
        const eventBase = scenario === "unrelated-base" ? unrelated : groupBase;
        const scripts = path.join(graphRepo, "scripts");
        const rules = path.join(graphRepo, ".github/branch-protection");
        mkdirSync(path.join(graphRepo, "apps/api"), { recursive: true });
        mkdirSync(scripts);
        mkdirSync(rules, { recursive: true });
        writeFileSync(
          path.join(rules, "ruleset-main.json"),
          JSON.stringify({
            rules: [
              {
                type: "merge_queue",
                parameters: {
                  max_entries_to_build: groupSize,
                  max_entries_to_merge: groupSize,
                },
              },
            ],
          }),
        );
        const fixtureScript = path.join(
          scripts,
          "rehearse-exact-base-upgrade.sh",
        );
        writeFileSync(fixtureScript, readFileSync(script));
        for (const { name, contents } of [
          { name: "git", contents: fakeGit },
          { name: "bun", contents: fakeBun },
        ]) {
          const executable = path.join(directory, name);
          writeFileSync(executable, contents);
          chmodSync(executable, 0o700);
        }
        const event = path.join(directory, "event.json");
        writeFileSync(
          event,
          JSON.stringify({
            merge_group: {
              base_sha: eventBase,
              head_sha: groupHead,
            },
          }),
        );
        const summary = path.join(directory, "summary");
        const checkoutLog = path.join(directory, "checkout");
        const run = Bun.spawnSync({
          cmd: ["bash", fixtureScript],
          env: {
            PATH: `${directory}:${process.env["PATH"] ?? ""}`,
            RUNNER_TEMP: directory,
            GITHUB_STEP_SUMMARY: summary,
            GITHUB_EVENT_NAME: "merge_group",
            GITHUB_EVENT_PATH: event,
            BASE_SHA: suppliedBase,
            DATABASE_URL: "postgres://local@127.0.0.1:5432/stella",
            CLEAN_DATABASE_URL: "postgres://local@127.0.0.1:5433/stella",
            GRAPH_REPO: graphRepo,
            REAL_GIT: realGit,
            CHECKOUT_LOG: checkoutLog,
            FAKE_OUTCOME: "pass",
            FAKE_STATE: directory,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(run.exitCode, run.stderr.toString()).toBe(
          scenario === "group-base" ? 0 : 1,
        );
        if (scenario === "group-base") {
          expect(readFileSync(checkoutLog, "utf-8").trim()).toBe(groupBase);
          const report = readFileSync(summary, "utf-8");
          expect(report).toContain(`| Base | \`${groupBase}\` |`);
          expect(report).toContain("| Verdict | pass |");
          return;
        }
        expect(run.stderr.toString()).toContain(
          scenario === "unrelated-base"
            ? "candidate is not built on the rehearsed base"
            : "Rehearse against the merge group's base_sha",
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
