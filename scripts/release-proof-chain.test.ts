import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const chain = path.join(import.meta.dir, "release-proof-chain.sh");
const healthGate = path.join(import.meta.dir, "check-release-main-health.sh");
const repository = "stella/stella";
const workflows = path.join(import.meta.dir, "../.github/workflows");
// Fixtures spawn git, the gate and the mock API dozens of times each.
const FIXTURE_TIMEOUT = 30_000;

const readWorkflow = (name: string) =>
  readFileSync(path.join(workflows, name), "utf-8");

// A string field of parsed YAML, or undefined when absent or not a string.
const stringField = (record: unknown, key: string): string | undefined => {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(record, key);
  return typeof value === "string" ? value : undefined;
};

// The body of a `run: |` step, dedented to its script.
const runStepBody = (source: string, name: string) => {
  const step = source
    .split(`      - name: ${name}\n`)
    .at(1)
    ?.split("      - name:")
    .at(0);
  const block = step?.split("run: |\n").at(1);
  expect(block).toBeDefined();
  return (block ?? "")
    .split("\n")
    .filter((line) => /^ {10,}\S/u.test(line) || line.trim() === "")
    .map((line) => line.slice(10))
    .join("\n");
};

type StatusOptions = {
  context: string;
  state?: string;
  description?: string;
  runId: number;
  workflow: string;
  title: string;
  sha: string;
  event?: string;
  headSha?: string;
  headBranch?: string;
  creator?: string;
};

const createFixture = (directory: string) => {
  const responses = path.join(directory, "responses");
  mkdirSync(responses);
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Chain test",
    GIT_AUTHOR_EMAIL: "chain-test@example.test",
    GIT_COMMITTER_NAME: "Chain test",
    GIT_COMMITTER_EMAIL: "chain-test@example.test",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    CHAIN_TEST_RESPONSES: responses,
    GH_RETRY_SCRIPT: path.join(directory, "gh-retry.sh"),
  };
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: directory,
      env: environment,
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  const commit = (files: Record<string, string>, message: string) => {
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeFileSync(path.join(directory, file), contents);
      git("add", "--", file);
    }
    git("commit", "--quiet", "--message", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet", "--initial-branch=main", "--template=");
  const root = commit(
    { "apps/web/src/a.ts": "0\n", VERSION: "1.0.0\n" },
    "root",
  );
  const anchor = commit({ "apps/web/src/a.ts": "1\n" }, "anchor");
  const middle = commit({ "apps/web/src/b.ts": "1\n" }, "middle");
  const target = commit(
    { VERSION: "1.0.1\n", "docs/changelog/v1.0.1.md": "notes\n" },
    "chore: release v1.0.1",
  );
  git("update-ref", "refs/remotes/origin/main", target);
  // A branch from the root that never contains the anchor.
  git("checkout", "--quiet", "-b", "side", root);
  const side = commit({ "apps/web/src/c.ts": "1\n" }, "side");
  git("checkout", "--quiet", "main");
  // A release PR head on top of main that also changes `file`.
  const branchWith = (file: string, contents = "changed\n") => {
    git("checkout", "--quiet", "-B", "candidate", target);
    const sha = commit({ [file]: contents }, `candidate ${file}`);
    git("checkout", "--quiet", "main");
    return sha;
  };
  // No scripts/ symlink: fixture commits write under scripts/, and every
  // script runs from its absolute path.
  writeFileSync(
    environment.GH_RETRY_SCRIPT,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" --method POST "* ]]; then
  printf '%s\\n' "$@" > "$CHAIN_TEST_RESPONSES/posted"
  exit 0
fi
endpoint="\${!#}"
case "$endpoint" in
  repos/stella/stella/commits/*/statuses?per_page=100)
    sha="\${endpoint#repos/stella/stella/commits/}"
    sha="\${sha%%/*}"
    if [[ -f "$CHAIN_TEST_RESPONSES/$sha-statuses" ]]; then
      cat "$CHAIN_TEST_RESPONSES/$sha-statuses"
    else
      printf '[[]]\\n'
    fi
    ;;
  repos/stella/stella/commits/*/check-runs?*)
    printf '[{"total_count":0,"check_runs":[]}]\\n'
    ;;
  repos/stella/stella/commits/*/pulls?per_page=100)
    printf '[[]]\\n'
    ;;
  repos/stella/stella/commits/*)
    sha="\${endpoint##*/}"
    printf '{"sha":"%s","commit":{"tree":{"sha":"%s"}}}\\n' "$sha" "$(git rev-parse "$sha^{tree}")"
    ;;
  repos/stella/stella/actions/runs/*)
    cat "$CHAIN_TEST_RESPONSES/run-\${endpoint##*/}"
    ;;
  repos/stella/stella/compare/*)
    sha="\${endpoint#repos/stella/stella/compare/}"
    sha="\${sha%...main}"
    base=$(git merge-base "$sha" origin/main)
    status=diverged
    [[ "$base" == "$sha" ]] && status=ahead
    printf '{"status":"%s","merge_base_commit":{"sha":"%s"}}\\n' "$status" "$base"
    ;;
  repos/stella/stella/issues?*)
    printf '[[ ]]\\n'
    ;;
  *) echo "Unexpected API endpoint: $endpoint" >&2; exit 1 ;;
esac
`,
  );
  const statuses = new Map<string, object[]>();
  // Newest first, as the statuses API returns them.
  const publishStatus = ({
    context,
    state = "success",
    description,
    runId,
    workflow,
    title,
    sha,
    event = "schedule",
    headSha = sha,
    headBranch = "main",
    creator = "github-actions[bot]",
  }: StatusOptions) => {
    const url = `https://github.com/${repository}/actions/runs/${String(runId)}`;
    writeFileSync(
      path.join(responses, `run-${String(runId)}`),
      JSON.stringify({
        id: runId,
        html_url: url,
        repository: { full_name: repository },
        path: `.github/workflows/${workflow}`,
        head_branch: headBranch,
        event,
        display_title: `${title}${sha}`,
        head_sha: headSha,
        status: "completed",
        conclusion: state === "success" ? "success" : "failure",
      }),
    );
    const list = [
      {
        context,
        state,
        creator: {
          login: creator,
          type: creator.endsWith("[bot]") ? "Bot" : "User",
        },
        target_url: url,
        description: description ?? `${context}: ${state}`,
      },
      ...(statuses.get(sha) ?? []),
    ];
    statuses.set(sha, list);
    writeFileSync(
      path.join(responses, `${sha}-statuses`),
      JSON.stringify([list]),
    );
  };
  let nextRun = 100;
  const heavy = (sha: string, options: Partial<StatusOptions> = {}) =>
    publishStatus({
      context: "main/heavy",
      workflow: "main-heavy.yml",
      title: "Main heavy suites ",
      description: "Main heavy suites: success",
      runId: nextRun++,
      sha,
      ...options,
    });
  const prDepth = (sha: string, options: Partial<StatusOptions> = {}) =>
    publishStatus({
      context: "main/pr-depth",
      workflow: "main-pr-depth.yml",
      title: "Main PR-depth checks ",
      description: "Main PR-depth checks: success",
      runId: nextRun++,
      sha,
      ...options,
    });
  const staging = (sha: string, options: Partial<StatusOptions> = {}) =>
    publishStatus({
      context: "staging/verified",
      workflow: "deploy-staging.yml",
      title: "Staging release proof ",
      event: "workflow_dispatch",
      runId: nextRun++,
      sha,
      ...options,
    });
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const result = Bun.spawnSync(["bash", ...args], {
      cwd: directory,
      env: { ...environment, ...extra },
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString(),
    };
  };
  const select = (sha: string) => run([chain, "--select", repository, sha]);
  const verify = (sha: string, from: string, workflowRevision = target) =>
    run([chain, "--verify", repository, sha, from, workflowRevision]);
  const gate = (sha: string) => run([healthGate, repository, sha, sha]);
  // Release-candidate evidence on `sha`: staging and PR-depth ran on it, and
  // main/heavy is chained from `from` with the description `description`.
  const chainedRelease = (
    sha: string,
    from: string,
    options: Partial<StatusOptions> = {},
  ) => {
    staging(sha);
    prDepth(sha, { event: "workflow_dispatch", headSha: target });
    heavy(sha, {
      event: "workflow_dispatch",
      headSha: target,
      description: `Main heavy suites: success; chain=${from}; main=${target}`,
      ...options,
    });
  };
  return {
    directory,
    environment,
    responses,
    root,
    anchor,
    middle,
    target,
    side,
    branchWith,
    heavy,
    prDepth,
    staging,
    select,
    verify,
    gate,
    chainedRelease,
    run,
  };
};

type Fixture = ReturnType<typeof createFixture>;

const withFixture = (body: (fixture: Fixture) => void) => {
  const directory = mkdtempSync(path.join(tmpdir(), "release-proof-chain-"));
  try {
    body(createFixture(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

// timeout: Builds Git histories and runs proof-verifier subprocesses against fixture API responses.
test(
  "a valid chain from a fully proven main ancestor is selected and accepted",
  () => {
    withFixture(({ anchor, middle, target, heavy, select, verify }) => {
      heavy(anchor);
      const selected = select(target);
      expect(selected.exitCode).toBe(0);
      // The middle commit has no heavy proof, so the nearest anchor is chosen.
      expect(selected.stdout).toBe(anchor);
      expect(verify(target, anchor).exitCode).toBe(0);
      heavy(middle);
      expect(select(target).stdout).toBe(middle);
    });
  },
  FIXTURE_TIMEOUT,
);

// timeout: Builds Git histories and runs proof-verifier subprocesses against fixture API responses.
test(
  "the release gate accepts a chained main/heavy only through the verified chain",
  () => {
    withFixture(({ anchor, target, heavy, chainedRelease, gate }) => {
      heavy(anchor);
      chainedRelease(target, anchor);
      const accepted = gate(target);
      expect(accepted.stderr).toContain("Proof chain holds");
      expect(accepted.exitCode).toBe(0);
    });
  },
  FIXTURE_TIMEOUT,
);

// timeout: Builds Git histories and runs proof-verifier subprocesses against fixture API responses.
test(
  "an anchor that is not an ancestor of the target is refused",
  () => {
    withFixture(({ anchor, side, heavy, verify, root }) => {
      heavy(anchor);
      const refused = verify(side, anchor);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain("is not an ancestor");
      // A side-branch commit is not on main, so it can never anchor.
      heavy(side);
      const offMain = verify(anchor, side);
      expect(offMain.exitCode).not.toBe(0);
      expect(offMain.stderr).toContain("not on main's first-parent history");
      // Nor can a commit anchor itself.
      expect(verify(root, root).exitCode).not.toBe(0);
    });
  },
  FIXTURE_TIMEOUT,
);

const unprovenAnchors = [
  ["missing heavy", (_fixture: Fixture) => {}],
  [
    "red heavy",
    ({ anchor, heavy }: Fixture) => {
      heavy(anchor);
      heavy(anchor, { state: "failure" });
    },
  ],
  [
    "red PR-depth beside a green heavy",
    ({ anchor, heavy, prDepth }: Fixture) => {
      heavy(anchor);
      prDepth(anchor, { state: "failure" });
    },
  ],
  [
    "red staging beside a green heavy",
    ({ anchor, heavy, staging }: Fixture) => {
      heavy(anchor);
      staging(anchor, { state: "error" });
    },
  ],
  [
    "chained heavy",
    ({ anchor, root, heavy }: Fixture) =>
      heavy(anchor, {
        description: `Main heavy suites: success; chain=${root}`,
      }),
  ],
] as const;
for (const [name, prove] of unprovenAnchors) {
  // timeout: Builds Git histories and runs proof-verifier subprocesses against fixture API responses.
  test(
    `an ancestor with ${name} is refused and never selected`,
    () => {
      withFixture((fixture) => {
        prove(fixture);
        const refused = fixture.verify(fixture.target, fixture.anchor);
        expect(refused.exitCode).not.toBe(0);
        expect(refused.stderr).toContain("is not fully proven");
        expect(fixture.select(fixture.target).stdout).toBe("");
      });
    },
    FIXTURE_TIMEOUT,
  );
}

const forcedFullFiles = [
  ".github/workflows/ci.yml",
  ".github/actions/ci-install/action.yml",
  "scripts/ci-plan-scope.ts",
  "scripts/release-proof-chain.sh",
  "bun.lock",
  "apps/desktop/src-tauri/Cargo.lock",
  "package.json",
  "packages/cli/package.json",
  "bun-toolchain.json",
  "apps/desktop/rust-toolchain.toml",
  "apps/api/Dockerfile",
  "packages/agent-engine/docker/sandbox.Dockerfile",
  "docker/postgres/init.sql",
  "apps/api/drizzle/20261021000000_change/migration.sql",
  "patches/some-package.patch",
  ".gitmodules",
];
// Workflows, the planner, lockfiles, manifests, toolchains, images and
// migrations.
for (const file of forcedFullFiles) {
  // timeout: Builds Git histories and runs proof-verifier subprocesses against fixture API responses.
  test(
    `a change to ${file} forces a full run`,
    () => {
      withFixture(({ anchor, heavy, branchWith, select, verify, run }) => {
        heavy(anchor);
        const candidate = branchWith(file);
        expect(run([chain, "--forced-full", anchor, candidate]).stdout).toBe(
          file,
        );
        expect(select(candidate).stdout).toBe("");
        const refused = verify(candidate, anchor);
        expect(refused.exitCode).not.toBe(0);
        expect(refused.stderr).toContain("require a full run");
      });
    },
    FIXTURE_TIMEOUT,
  );
}

// timeout: Builds Git histories and runs proof-verifier subprocesses against fixture API responses.
test(
  "ordinary source and documentation changes do not force a full run",
  () => {
    withFixture(({ anchor, target, run }) => {
      expect(run([chain, "--forced-full", anchor, target]).stdout).toBe("");
    });
  },
  FIXTURE_TIMEOUT,
);

const forgedEvidence: readonly [string, (fixture: Fixture) => void][] = [
  [
    "a status not written by GitHub Actions",
    ({ anchor, target, chainedRelease }) =>
      chainedRelease(target, anchor, { creator: "someone" }),
  ],
  [
    "a run of another workflow",
    ({ anchor, target, chainedRelease }) =>
      chainedRelease(target, anchor, { workflow: "ci.yml" }),
  ],
  [
    "a run from a branch",
    ({ anchor, target, chainedRelease }) =>
      chainedRelease(target, anchor, { headBranch: "feature" }),
  ],
  [
    "a workflow revision that is not on main",
    ({ anchor, target, side, chainedRelease }) =>
      chainedRelease(target, anchor, { headSha: side }),
  ],
  [
    "a malformed chain description",
    ({ anchor, root, target, chainedRelease }) =>
      chainedRelease(target, anchor, {
        description: `Main heavy suites: success; chain=${anchor}; chain=${root}`,
      }),
  ],
  [
    "a chained failure",
    ({ anchor, target, chainedRelease }) =>
      chainedRelease(target, anchor, {
        state: "failure",
        description: `Main heavy suites: failure (CODE 1, INFRA 0); chain=${anchor}`,
      }),
  ],
  [
    "a chain to an unproven ancestor",
    ({ middle, target, chainedRelease }) => chainedRelease(target, middle),
  ],
  [
    "a chained PR-depth status",
    ({ anchor, target, chainedRelease, prDepth }) => {
      chainedRelease(target, anchor);
      prDepth(target, {
        event: "workflow_dispatch",
        headSha: target,
        description: `Main PR-depth checks: success; chain=${anchor}`,
      });
    },
  ],
];
for (const [name, forge] of forgedEvidence) {
  // timeout: Builds Git histories and runs proof-verifier subprocesses against fixture API responses.
  test(
    `the release gate refuses chained heavy evidence from ${name}`,
    () => {
      withFixture((fixture) => {
        fixture.heavy(fixture.anchor);
        forge(fixture);
        const refused = fixture.gate(fixture.target);
        expect(refused.exitCode).not.toBe(0);
        expect(refused.stderr).toContain("RELEASE_");
      });
    },
    FIXTURE_TIMEOUT,
  );
}

// timeout: Builds Git histories and runs proof-verifier subprocesses against fixture API responses.
test(
  "the heavy status main-heavy.yml publishes for a chained run is the one the gate accepts",
  () => {
    withFixture((fixture) => {
      const { anchor, target, heavy, staging, prDepth, responses, run } =
        fixture;
      heavy(anchor);
      const body = runStepBody(
        readWorkflow("main-heavy.yml"),
        "Publish heavy conclusion",
      );
      const published = run(["-c", body], {
        REPOSITORY: repository,
        SHA: target,
        RESULTS: JSON.stringify({
          validate: { result: "success" },
          suites: { result: "success" },
        }),
        RUN_URL: `https://github.com/${repository}/actions/runs/900`,
        DESCRIPTION: "Main heavy suites: success",
        PROOF_MAIN_BASE: target,
        PROOF_CHAIN_BASE: anchor,
      });
      expect(published.exitCode).toBe(0);
      const description = readFileSync(path.join(responses, "posted"), "utf-8")
        .split("\n")
        .find((line) => line.startsWith("description="))
        ?.slice("description=".length);
      expect(description).toBe(
        `Main heavy suites: success; chain=${anchor}; main=${target}`,
      );
      staging(target);
      prDepth(target, { event: "workflow_dispatch", headSha: target });
      heavy(target, {
        event: "workflow_dispatch",
        headSha: target,
        description: description ?? "",
      });
      expect(fixture.gate(target).exitCode).toBe(0);
    });
  },
  FIXTURE_TIMEOUT,
);

// timeout: Builds Git histories and runs proof-verifier subprocesses against fixture API responses.
test(
  "ci-plan accepts a chain base only as a strict ancestor in a heavy-only run",
  () => {
    withFixture(({ anchor, target, side, directory, environment }) => {
      const body = runStepBody(
        readWorkflow("ci.yml"),
        "Resolve proof chain base",
      );
      const resolve = (base: string, heavyOnly = "true", head = target) => {
        const output = path.join(
          directory,
          `chain-output-${base}-${heavyOnly}`,
        );
        writeFileSync(output, "");
        Bun.spawnSync(["git", "checkout", "--quiet", "--detach", head], {
          cwd: directory,
          env: environment,
        });
        const result = Bun.spawnSync(["bash", "-e", "-c", body], {
          cwd: directory,
          env: {
            ...environment,
            CHAIN_BASE: base,
            HEAVY_ONLY: heavyOnly,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
          },
        });
        return {
          exitCode: result.exitCode,
          output: readFileSync(output, "utf-8"),
        };
      };
      expect(resolve(anchor)).toEqual({
        exitCode: 0,
        output: `base=${anchor}\nplan_event=merge_group\n`,
      });
      expect(resolve(anchor, "false").exitCode).not.toBe(0);
      expect(resolve(side).exitCode).not.toBe(0);
      expect(resolve(target).exitCode).not.toBe(0);
      expect(resolve("not-a-sha").exitCode).not.toBe(0);
    });
  },
  FIXTURE_TIMEOUT,
);

test("a chained heavy run requires every affected job and carries the unaffected ones", () => {
  const workflow: unknown = Bun.YAML.parse(readWorkflow("ci.yml"));
  const step = workflowStepByName(
    workflowJobSteps(workflow, "ci-result"),
    "Evaluate CI outcome",
  );
  const script = stringField(step, "run");
  const runnerLossReporter = script
    ?.match(/^report_required_runner_losses\(\) \{[\s\S]*?^\}/mu)
    ?.at(0);
  expect(runnerLossReporter).toBeDefined();
  const evaluate = script
    ?.split(/^ {2}full\)\n/mu)
    .at(1)
    ?.split(/^ {2}fast\)\n/mu)
    .at(0);
  expect(evaluate).toBeDefined();
  const scopes = stringField(step["env"], "JOB_SCOPES");
  const folded = stringField(step["env"], "FOLDED_SUITES");
  expect(scopes).toBeDefined();
  expect(folded).toBeDefined();
  const directory = mkdtempSync(path.join(tmpdir(), "release-proof-chain-"));
  try {
    const summary = path.join(directory, "summary");
    const planFile = path.join(directory, "plan.json");
    // The diff affects Postgres suites only. ci-result reads the planner file.
    writeFileSync(
      planFile,
      JSON.stringify({
        postgres_service_suites_required: "true",
        e2e_landing_required: "false",
        web_image_smoke_required: "false",
      }),
    );
    const outcome = (results: Record<string, string>) => {
      writeFileSync(summary, "");
      const result = Bun.spawnSync(
        [
          "bash",
          "-e",
          "-o",
          "pipefail",
          "-c",
          // Prerequisite evidence passed with no runner-loss or queue exemptions.
          `${runnerLossReporter ?? ""}\nheavy_skippable='[]'\nrunner_lost_jobs='[]'\ncase full in\nfull)\n${evaluate ?? ""}\nesac`,
        ],
        {
          env: {
            ...process.env,
            HEAVY_ONLY: "true",
            CHAIN_BASE: "a".repeat(40),
            QUEUE_DEPTH: "full",
            THIN_JOBS: "[]",
            JOB_SCOPES: scopes ?? "",
            FOLDED_SUITES: folded ?? "",
            GITHUB_STEP_SUMMARY: summary,
            PLAN_FILE: planFile,
            NEEDS: JSON.stringify({
              "ci-plan": { result: "success" },
              ...Object.fromEntries(
                Object.entries(results).map(([job, conclusion]) => [
                  job,
                  { result: conclusion, outputs: {} },
                ]),
              ),
            }),
          },
        },
      );
      return {
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        summary: readFileSync(summary, "utf-8"),
      };
    };
    const carried = outcome({
      "postgres-service-suites": "success",
      "e2e-landing": "skipped",
      "web-image-smoke": "skipped",
    });
    expect(carried.exitCode, carried.stderr).toBe(0);
    expect(carried.summary).toContain(`Proof chained from ${"a".repeat(40)}`);
    expect(carried.summary).toContain(
      "Ran on this commit: postgres-service-suites",
    );
    expect(carried.summary).toContain(
      "Carried over from the ancestor: e2e-landing, web-image-smoke",
    );
    for (const result of ["failure", "skipped", "cancelled"]) {
      expect(
        outcome({
          "postgres-service-suites": result,
          "e2e-landing": "skipped",
          "web-image-smoke": "skipped",
        }).exitCode,
        result,
      ).not.toBe(0);
    }
    // An unaffected job that ran and failed still fails the run.
    expect(
      outcome({
        "postgres-service-suites": "success",
        "e2e-landing": "failure",
        "web-image-smoke": "skipped",
      }).exitCode,
    ).not.toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a chained heavy run plans its changed-file scope as a merge group against the anchor", () => {
  const source = readWorkflow("ci.yml");
  const step = (name: string) =>
    source
      .split(`      - name: ${name}\n`)
      .at(1)
      ?.split("      - name:")
      .at(0) ?? "";
  const scope = step("Check changed file scope");
  expect(scope).toContain(
    `BASE_SHA: \${{ steps.chain.outputs.base || steps.target-base.outputs.base_sha }}`,
  );
  expect(scope).toContain(
    `EVENT_NAME: \${{ steps.chain.outputs.plan_event || github.event_name }}`,
  );
  expect(scope).toContain(
    `HEAVY_ONLY: \${{ inputs.heavy_only == true && steps.chain.outputs.base == '' }}`,
  );
  // Only a pinned dispatch chains; schedules and pushes stay full anchors.
  const main = readWorkflow("main-heavy.yml");
  expect(main).toContain(
    `CHAIN_ENABLED: \${{ github.event_name == 'workflow_dispatch' && inputs.sha != '' && inputs.proof_chain != false }}`,
  );
  expect(main).toContain(
    `chain_base: \${{ needs.validate.outputs.chain-base }}`,
  );
  // The tag job keeps the verifier beside the gate it copies.
  expect(readWorkflow("release-tag.yml")).toContain(
    'cp scripts/release-proof-chain.sh "$RUNNER_TEMP/release-proof-chain.sh"',
  );
});
