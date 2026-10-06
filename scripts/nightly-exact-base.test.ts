import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const root = path.resolve(import.meta.dir, "..");
const nightlyPath = ".github/workflows/nightly-test.yml";
const readWorkflow = (source: string) =>
  v.parse(
    v.object({ jobs: v.record(v.string(), v.unknown()) }),
    Bun.YAML.parse(source),
  ).jobs;
const ci = readWorkflow(
  readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
);
const nightly = readWorkflow(
  readFileSync(path.join(root, nightlyPath), "utf-8"),
);
const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  return new TextDecoder().decode(result.stdout).trim();
};
const requiredSet = (jobs: Record<string, unknown>) => {
  const job = v.parse(
    v.object({
      needs: v.array(v.string()),
      steps: v.array(
        v.object({
          name: v.optional(v.string()),
          env: v.optional(v.record(v.string(), v.string())),
        }),
      ),
    }),
    jobs["ci-result"],
  );
  const env = job.steps.find(({ name }) => name === "Evaluate CI outcome")?.env;
  return {
    needs: new Set(job.needs),
    scopes: JSON.parse(env?.["JOB_SCOPES"] ?? ""),
    fast: new Set(
      v.parse(v.array(v.string()), JSON.parse(env?.["FAST_REQUIRED"] ?? "")),
    ),
  };
};

test("moving the advisory job preserves the exact required CI set", () => {
  // Derive both contracts from the actual introducing commit, rather than
  // keeping a second manifest that future gate changes could silently drift.
  const introduced = git([
    "log",
    "-n",
    "1",
    "--format=%H",
    "-G",
    "^  migration-exact-base-upgrade:",
    "--",
    nightlyPath,
  ]);
  const before = readWorkflow(
    git([
      "show",
      `${introduced ? `${introduced}^` : "HEAD"}:.github/workflows/ci.yml`,
    ]),
  );
  const after = introduced
    ? readWorkflow(git(["show", `${introduced}:.github/workflows/ci.yml`]))
    : ci;
  expect(requiredSet(after)).toEqual(requiredSet(before));
  const advisory = "migration-exact-base-upgrade";
  expect(
    v.parse(
      v.object({ "continue-on-error": v.literal(true) }),
      before[advisory],
    ),
  ).toEqual({ "continue-on-error": true });
  expect(after).not.toHaveProperty(advisory);
  for (const jobs of [before, after, ci]) {
    const required = requiredSet(jobs);
    expect(required.needs).not.toContain(advisory);
    expect(required.scopes).not.toHaveProperty(advisory);
    expect(required.fast).not.toContain(advisory);
  }
}, 30_000);

test("nightly rehearsal checks main and reports failures with isolated write permissions", () => {
  const job = v.parse(
    v.object({
      permissions: v.record(v.string(), v.string()),
      steps: v.array(
        v.object({
          name: v.string(),
          uses: v.optional(v.string()),
          run: v.optional(v.string()),
          with: v.optional(v.record(v.string(), v.unknown())),
          env: v.optional(v.record(v.string(), v.string())),
        }),
      ),
    }),
    nightly["migration-exact-base-upgrade"],
  );
  expect(job.permissions).toEqual({ contents: "read" });
  expect(
    job.steps.find(({ name }) => name === "Checkout")?.with,
  ).not.toHaveProperty("ref");
  const resolveMain = job.steps.find(
    ({ name }) => name === "Resolve previous main state",
  )?.run;
  expect(resolveMain).toContain(
    "git fetch --no-tags origin refs/heads/main\ngit checkout --detach FETCH_HEAD\n",
  );
  expect(
    job.steps.find(
      ({ name }) => name === "Rehearse exact-base migration upgrade",
    )?.env?.["BASE_SHA"],
  ).toBe(`\${{ steps.base.outputs.sha }}`);
  const report = v.parse(
    v.object({
      needs: v.string(),
      if: v.string(),
      concurrency: v.object({
        group: v.string(),
        "cancel-in-progress": v.literal(false),
      }),
      permissions: v.record(v.string(), v.string()),
      steps: v.array(
        v.object({ env: v.optional(v.record(v.string(), v.string())) }),
      ),
    }),
    nightly["report-failure"],
  );
  expect(report.needs).toBe("migration-exact-base-upgrade");
  expect(report.if).toContain(
    "needs.migration-exact-base-upgrade.result == 'failure'",
  );
  // A scheduled rehearsal that hits its timeout is cancelled, not failed.
  expect(report.if).toContain(
    "github.event_name == 'schedule' && needs.migration-exact-base-upgrade.result == 'cancelled'",
  );
  expect(report.if).toContain("always()");
  expect(report.permissions).toEqual({ contents: "read", issues: "write" });
  expect(report.concurrency.group).toBe("nightly-exact-base-failure-issue");
  expect(
    report.steps.find(({ env }) => env?.["DRY_RUN"])?.env?.["DRY_RUN"],
  ).toContain("github.ref != 'refs/heads/main'");
});

const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *--slurp* && ( "$*" == *--jq* || "$*" == *--template* ) ]]; then
  printf '%s\\n' 'the --slurp option is not supported with --jq or --template' >&2
  exit 1
fi
if [[ "$*" == *--method* ]]; then
  jq -cn --args '$ARGS.positional' -- "$@" >> "$FAKE_MUTATIONS"
  if [[ "$*" == *"--input -"* ]]; then cat > "$FAKE_PAYLOAD"; fi
  exit 0
fi
if [[ "$*" == *"/issues?"* ]]; then
  [[ "\${FAIL_READ:-false}" == false ]] || exit 2
  cat "$FAKE_ISSUES"
  exit 0
fi
if [[ "$*" == *"/labels?"* ]]; then cat "$FAKE_LABELS"; exit 0; fi
exit 3
`;

test.each([
  { issue: null, dryRun: "true", failRead: "false", code: 0, writes: 0 },
  { issue: 42, dryRun: "true", failRead: "false", code: 0, writes: 0 },
  { issue: null, dryRun: "false", failRead: "false", code: 0, writes: 2 },
  { issue: 42, dryRun: "false", failRead: "false", code: 0, writes: 1 },
  { issue: null, dryRun: "false", failRead: "true", code: 2, writes: 0 },
])(
  "failure reporting creates or updates one issue and never writes in dry runs: %j",
  ({ issue, dryRun, failRead, code, writes }) => {
    const directory = mkdtempSync(path.join(tmpdir(), "exact-base-issue-"));
    const mutations = path.join(directory, "mutations");
    const payload = path.join(directory, "payload");
    const issues = path.join(directory, "issues.json");
    const labels = path.join(directory, "labels.json");
    const runUrl = "https://github.com/stella/stella/actions/runs/12345";
    writeFileSync(path.join(directory, "gh"), fakeGh, { mode: 0o755 });
    writeFileSync(mutations, "");
    writeFileSync(labels, JSON.stringify([[{ name: "other" }], []]));
    // Exercise pagination, title matching, PR exclusion, and deterministic
    // selection when historical duplicate issues already exist.
    writeFileSync(
      issues,
      JSON.stringify([
        [
          { number: 1, title: "other" },
          {
            number: 2,
            title: "migration-exact-base-upgrade",
            pull_request: {},
          },
        ],
        issue === null
          ? []
          : [
              { number: 100, title: "migration-exact-base-upgrade" },
              { number: issue, title: "migration-exact-base-upgrade" },
            ],
      ]),
    );
    try {
      const result = Bun.spawnSync(
        ["bash", path.join(root, "scripts/report-exact-base-failure.sh")],
        {
          env: {
            PATH: `${directory}:${process.env["PATH"] ?? ""}`,
            REPOSITORY: "stella/stella",
            RUN_URL: runUrl,
            DRY_RUN: dryRun,
            FAKE_MUTATIONS: mutations,
            FAKE_PAYLOAD: payload,
            FAKE_ISSUES: issues,
            FAKE_LABELS: labels,
            FAIL_READ: failRead,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(
        code,
      );
      const calls = readFileSync(mutations, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => v.parse(v.array(v.string()), JSON.parse(line)));
      expect(calls).toHaveLength(writes);
      if (dryRun === "true") {
        expect(new TextDecoder().decode(result.stdout)).toContain(runUrl);
      }
      if (issue !== null && dryRun === "false") {
        expect(calls.at(0)).toContain("repos/stella/stella/issues/42");
      }
      if (issue === null && dryRun === "false" && failRead === "false") {
        expect(JSON.parse(readFileSync(payload, "utf-8"))).toEqual({
          title: "migration-exact-base-upgrade",
          body: `Job: \`migration-exact-base-upgrade\`\n\nRun: ${runUrl}`,
          labels: ["routine-fixes"],
        });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
