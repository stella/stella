import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import * as v from "valibot";

import { checkReleaseStagePrerequisites } from "./check-release-stage-prerequisites";

const root = nodePath.resolve(import.meta.dir, "..");

test("the stage cannot hold the promotion lock while waiting for deployment", () => {
  const concurrency = v.object({
    group: v.string(),
    "cancel-in-progress": v.literal(false),
  });
  const stage = v.parse(
    v.object({ concurrency }),
    Bun.YAML.parse(
      readFileSync(
        nodePath.join(root, ".github/workflows/release-stage.yml"),
        "utf-8",
      ),
    ),
  );
  const deploy = v.parse(
    v.object({
      jobs: v.object({ "promote-staging": v.object({ concurrency }) }),
    }),
    Bun.YAML.parse(
      readFileSync(
        nodePath.join(root, ".github/workflows/deploy-staging.yml"),
        "utf-8",
      ),
    ),
  );
  expect(stage.concurrency.group).not.toBe(
    deploy.jobs["promote-staging"].concurrency.group,
  );
});

test("release staging binds every required check to the aggregator contract before deployment", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(nodePath.join(root, ".github/workflows/ci.yml"), "utf-8"),
  );
  const jobs = v.parse(
    v.object({
      jobs: v.object({
        "release-stage": v.object({ needs: v.array(v.string()) }),
        "ci-result": v.object({
          needs: v.array(v.string()),
          steps: v.array(
            v.looseObject({
              name: v.optional(v.string()),
              env: v.optional(v.record(v.string(), v.string())),
            }),
          ),
        }),
      }),
    }),
    workflow,
  ).jobs;
  const scopes = v.parse(
    v.record(v.string(), v.nullable(v.string())),
    JSON.parse(
      jobs["ci-result"].steps.find(({ name }) => name === "Evaluate CI outcome")
        ?.env?.["JOB_SCOPES"] ?? "",
    ),
  );
  expect(jobs["release-stage"].needs.toSorted()).toEqual(
    jobs["ci-result"].needs.filter((job) => job !== "release-stage").toSorted(),
  );
  const plan = Object.fromEntries(
    Object.values(scopes)
      .filter((scope) => scope !== null)
      .map((scope) => [scope, "true"]),
  );
  const needs = Object.fromEntries(
    jobs["release-stage"].needs.map((job) => [job, { result: "success" }]),
  );
  checkReleaseStagePrerequisites({ workflow, needs, plan });
  for (const job of jobs["release-stage"].needs) {
    for (const result of ["skipped", "failure", "cancelled"]) {
      expect(() =>
        checkReleaseStagePrerequisites({
          workflow,
          plan,
          needs: { ...needs, [job]: { result } },
        }),
      ).toThrow(
        job === "ci-plan"
          ? "CI plan did not succeed"
          : `CI prerequisite ${job}`,
      );
    }
  }
  expect(() =>
    checkReleaseStagePrerequisites({
      workflow,
      needs: { "ci-plan": { result: "success" } },
      plan,
    }),
  ).toThrow("must depend on every CI prerequisite");
  for (const [job, scope] of Object.entries(scopes)) {
    if (job === "release-stage" || scope === null) {
      continue;
    }
    checkReleaseStagePrerequisites({
      workflow,
      needs: { ...needs, [job]: { result: "skipped" } },
      plan: { ...plan, [scope]: "false" },
    });
    expect(() =>
      checkReleaseStagePrerequisites({
        workflow,
        needs,
        plan: { ...plan, [scope]: "" },
      }),
    ).toThrow("Missing plan scope");
  }
});
type RunOptions = { cwd: string; env?: Record<string, string> };
const run = (cmd: string[], { cwd, env = {} }: RunOptions) => {
  const result = Bun.spawnSync(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    out: new TextDecoder().decode(result.stdout),
    error: new TextDecoder().decode(result.stderr),
  };
};

test("release entry plans staging; inherited version identities remain visible to other entries", () => {
  const directory = mkdtempSync(nodePath.join(tmpdir(), "release-stage-plan-"));
  const git = (...args: string[]) => {
    const result = run(["git", ...args], { cwd: directory });
    expect(result.code, result.error).toBe(0);
    return result.out.trim();
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    writeFileSync(nodePath.join(directory, "VERSION"), "1.0.0\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(nodePath.join(directory, "VERSION"), "1.0.1\n");
    git("commit", "-qam", "version");
    const version = git("rev-parse", "HEAD");
    writeFileSync(nodePath.join(directory, "README.md"), "fixture\n");
    git("add", ".");
    git("commit", "-qm", "following entry");
    const head = git("rev-parse", "HEAD");
    mkdirSync(nodePath.join(directory, "bin"));
    const gh = nodePath.join(directory, "bin/gh");
    writeFileSync(
      gh,
      `#!/bin/sh\nprintf '%s\\n' '[{"number":7,"title":"chore: release v1.0.1","isDraft":false,"isCrossRepository":false}]'\n`,
    );
    chmodSync(gh, 0o755);
    const env = {
      PATH: `${nodePath.join(directory, "bin")}:${process.env["PATH"] ?? ""}`,
      GITHUB_REPOSITORY: "stella/stella",
      RELEASE_BASE_SHA: base,
      RELEASE_HEAD_SHA: head,
    };
    for (const [event, number, required] of [
      ["merge_group", "7", true],
      ["merge_group", "8", false],
      ["pull_request", "7", false],
    ] as const) {
      const result = run(
        ["bash", nodePath.join(root, "scripts/plan-release-stage.sh")],
        {
          cwd: directory,
          env: {
            ...env,
            EVENT_NAME: event,
            PR_NUMBER: number,
            MERGE_GROUP_HEAD_REF: `refs/heads/gh-readonly-queue/main/pr-${number}-${base}`,
          },
        },
      );
      expect(result.code, result.error).toBe(0);
      expect(result.out).toContain(`release_stage_required=${required}\n`);
      expect(result.out).toContain(`release_version_commits=["${version}"]\n`);
    }
    const empty = run(
      ["bash", nodePath.join(root, "scripts/plan-release-stage.sh")],
      {
        cwd: directory,
        env: {
          ...env,
          EVENT_NAME: "push",
          RELEASE_BASE_SHA: version,
        },
      },
    );
    expect(empty.out).toContain("release_version_commits=[]\n");
    const invalid = run(
      ["bash", nodePath.join(root, "scripts/plan-release-stage.sh")],
      {
        cwd: directory,
        env: {
          ...env,
          EVENT_NAME: "merge_group",
          MERGE_GROUP_HEAD_REF: "refs/heads/main",
        },
      },
    );
    expect(invalid.code).toBe(1);
    expect(invalid.error).toContain("RELEASE_STAGE_PLAN_REFUSED");

    // A pull request whose base moved past its branch point compares from
    // the branch point instead of requiring ancestry.
    git("checkout", "-qb", "moved-main", base);
    writeFileSync(nodePath.join(directory, "MAIN.md"), "moved\n");
    git("add", ".");
    git("commit", "-qm", "main moves");
    const movedMain = git("rev-parse", "HEAD");
    git("checkout", "-q", head);
    const behind = run(
      ["bash", nodePath.join(root, "scripts/plan-release-stage.sh")],
      {
        cwd: directory,
        env: {
          ...env,
          EVENT_NAME: "pull_request",
          PR_NUMBER: "8",
          RELEASE_BASE_SHA: movedMain,
        },
      },
    );
    expect(behind.code, behind.error).toBe(0);
    expect(behind.out).toContain(`release_version_commits=["${version}"]\n`);

    // A non-release queue entry that changes VERSION itself can never be
    // staged, so planning refuses it; the release entry plans staging.
    writeFileSync(nodePath.join(directory, "VERSION"), "1.0.2\n");
    git("commit", "-qam", "unreleased version");
    const versionHead = git("rev-parse", "HEAD");
    for (const [number, code] of [
      ["8", 1],
      ["7", 0],
    ] as const) {
      const entry = run(
        ["bash", nodePath.join(root, "scripts/plan-release-stage.sh")],
        {
          cwd: directory,
          env: {
            ...env,
            EVENT_NAME: "merge_group",
            PR_NUMBER: number,
            MERGE_GROUP_HEAD_REF: `refs/heads/gh-readonly-queue/main/pr-${number}-${base}`,
            RELEASE_HEAD_SHA: versionHead,
          },
        },
      );
      expect(entry.code, entry.error).toBe(code);
      if (code === 1) {
        expect(entry.error).toContain(
          "RELEASE_STAGE_PLAN_REFUSED: VERSION changed outside a release pull request",
        );
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("inherited release proof waits for missing status, fails red, and accepts every exact version commit", () => {
  const directory = mkdtempSync(
    nodePath.join(tmpdir(), "release-stage-status-"),
  );
  const sha = "a".repeat(40);
  try {
    const { jobs } = v.parse(
      v.object({
        jobs: v.object({
          "ci-result": v.object({
            steps: v.array(
              v.looseObject({
                name: v.optional(v.string()),
                run: v.optional(v.string()),
              }),
            ),
          }),
        }),
      }),
      Bun.YAML.parse(
        readFileSync(nodePath.join(root, ".github/workflows/ci.yml"), "utf-8"),
      ),
    );
    const evaluator =
      jobs["ci-result"].steps.find(({ name }) => name === "Evaluate CI outcome")
        ?.run ?? "";
    const start = evaluator.indexOf("# HEADGREEN groups behind the release");
    const end = evaluator.indexOf("# Completion evidence", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const gate = evaluator.slice(start, end);
    mkdirSync(nodePath.join(directory, ".workflow-tooling/scripts"), {
      recursive: true,
    });
    writeFileSync(
      nodePath.join(
        directory,
        ".workflow-tooling/scripts/wait-release-staging-status.sh",
      ),
      readFileSync(
        nodePath.join(root, "scripts/wait-release-staging-status.sh"),
      ),
    );
    const gh = nodePath.join(directory, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh
count=0
if [ -f "$STATUS_COUNTER" ]; then count=$(cat "$STATUS_COUNTER"); fi
count=$((count + 1))
printf '%s' "$count" > "$STATUS_COUNTER"
case "$STATUS_MODE" in
  timeout) echo '[{"statuses":[]}]' ;;
  second-red) if [ "$count" -eq 2 ]; then echo '[{"statuses":[{"context":"staging/verified","state":"failure"}]}]'; else echo '[{"statuses":[{"context":"staging/verified","state":"success"}]}]'; fi ;;
  wait) if [ "$count" -eq 1 ]; then echo '[{"statuses":[]}]'; else echo '[{"statuses":[{"context":"staging/verified","state":"success"}]}]'; fi ;;
  *) printf '[{"statuses":[{"context":"staging/verified","state":"%s"}]}]\\n' "$STATUS_MODE" ;;
esac
`,
    );
    chmodSync(gh, 0o755);
    writeFileSync(
      nodePath.join(directory, "sleep"),
      '#!/bin/sh\nif [ "$STATUS_MODE" = timeout ]; then /bin/sleep 1; fi\n',
    );
    chmodSync(nodePath.join(directory, "sleep"), 0o755);
    writeFileSync(
      nodePath.join(directory, "retry.sh"),
      '#!/bin/sh\nexec gh "$@"\n',
    );
    for (const [mode, code] of [
      ["wait", 0],
      ["failure", 1],
      ["error", 1],
      ["success", 0],
      ["second-red", 1],
      ["timeout", 1],
    ] as const) {
      const result = run(["bash", "-e", "-c", gate], {
        cwd: directory,
        env: {
          GITHUB_REPOSITORY: "stella/stella",
          EVENT: "merge_group",
          PLAN: JSON.stringify({
            release_stage_required: "false",
            release_version_commits: JSON.stringify([sha, "b".repeat(40)]),
          }),
          STATUS_COUNTER: nodePath.join(directory, `counter-${mode}`),
          STATUS_MODE: mode,
          RELEASE_STATUS_TIMEOUT_SECONDS: mode === "timeout" ? "1" : "7200",
          GH_RETRY_SCRIPT: nodePath.join(directory, "retry.sh"),
          PATH: `${directory}:${process.env["PATH"] ?? ""}`,
        },
      });
      expect(result.code, result.error).toBe(code);
      if (code === 1) {
        expect(result.error).toContain(
          mode === "timeout"
            ? "RELEASE_STAGING_TIMEOUT"
            : "RELEASE_STAGING_FAILED",
        );
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
