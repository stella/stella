import { expect, test } from "bun:test";
import {
  chmodSync,
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
case "$3 $4" in
  "rev-parse HEAD") printf '%s\\n' "$FAKE_CANDIDATE" ;;
  "rev-parse --verify")
    if [[ "$5" == *"^1" ]]; then
      printf '%s\\n' "\${FAKE_PARENT:-$BASE_SHA}"
    else
      printf '%s\\n' "$BASE_SHA"
    fi ;;
  "merge-base --is-ancestor") exit "\${FAKE_ANCESTRY_STATUS:-0}" ;;
  "worktree add") mkdir -p "$6/apps/api" ;;
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

const otherSha = "c".repeat(40);

for (const { name, eventBase, parent, ancestryStatus, exitCode, message } of [
  {
    name: "rehearses a candidate built on the merge group's base",
    eventBase: base,
    parent: base,
    ancestryStatus: 0,
    exitCode: 0,
    message: null,
  },
  {
    name: "rehearses grouped entries with an intermediate parent",
    eventBase: base,
    parent: otherSha,
    ancestryStatus: 0,
    exitCode: 0,
    message: null,
  },
  {
    name: "refuses a base other than the merge group's base_sha",
    eventBase: otherSha,
    parent: base,
    ancestryStatus: 0,
    exitCode: 1,
    message: "Rehearse against the merge group's base_sha",
  },
  {
    name: "refuses a candidate that is not built on the rehearsed base",
    eventBase: base,
    parent: otherSha,
    ancestryStatus: 1,
    exitCode: 1,
    message: "candidate is not built on the rehearsed base",
  },
]) {
  test(`merge group ${name}`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), "exact-base-group-"));
    try {
      for (const { name: tool, contents } of [
        { name: "git", contents: fakeGit },
        { name: "bun", contents: fakeBun },
      ]) {
        const executable = path.join(directory, tool);
        writeFileSync(executable, contents);
        chmodSync(executable, 0o700);
      }
      const event = path.join(directory, "event.json");
      writeFileSync(
        event,
        JSON.stringify({ merge_group: { base_sha: eventBase } }),
      );
      const run = Bun.spawnSync({
        cmd: ["bash", script],
        env: {
          PATH: `${directory}:${process.env["PATH"] ?? ""}`,
          RUNNER_TEMP: directory,
          GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
          GITHUB_EVENT_NAME: "merge_group",
          GITHUB_EVENT_PATH: event,
          BASE_SHA: base,
          DATABASE_URL: "postgres://local@127.0.0.1:5432/stella",
          CLEAN_DATABASE_URL: "postgres://local@127.0.0.1:5433/stella",
          FAKE_CANDIDATE: candidate,
          FAKE_PARENT: parent,
          FAKE_ANCESTRY_STATUS: String(ancestryStatus),
          FAKE_OUTCOME: "pass",
          FAKE_STATE: directory,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = new TextDecoder().decode(run.stderr);
      expect(run.exitCode, stderr).toBe(exitCode);
      if (message !== null) {
        expect(stderr).toContain(message);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
