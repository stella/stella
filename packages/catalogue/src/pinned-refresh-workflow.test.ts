import { panic } from "better-result";
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const stepSchema = v.looseObject({
  name: v.string(),
  id: v.optional(v.string()),
  if: v.optional(v.string()),
  run: v.optional(v.string()),
  uses: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
  env: v.optional(v.record(v.string(), v.string())),
});
const actionStepSchema = v.required(stepSchema, ["uses"]);

const workflowSchema = v.looseObject({
  permissions: v.record(v.string(), v.string()),
  jobs: v.record(
    v.string(),
    v.looseObject({
      permissions: v.record(v.string(), v.string()),
      steps: v.array(stepSchema),
    }),
  ),
});
const workflow = v.parse(
  workflowSchema,
  Bun.YAML.parse(
    await Bun.file(
      new URL(
        "../../../.github/workflows/catalogue-upstream.yml",
        import.meta.url,
      ),
    ).text(),
  ),
);
const precedent = v.parse(
  workflowSchema,
  Bun.YAML.parse(
    await Bun.file(
      new URL(
        "../../../.github/workflows/model-catalog-check.yml",
        import.meta.url,
      ),
    ).text(),
  ),
);
const precedentSteps = Object.values(precedent.jobs).flatMap(
  ({ steps: jobSteps }) => jobSteps,
);
const precedentApp = v.parse(
  actionStepSchema,
  precedentSteps.find(({ uses }) =>
    uses?.startsWith("actions/create-github-app-token@"),
  ),
);
const precedentProposal = v.parse(
  actionStepSchema,
  precedentSteps.find(({ with: inputs }) => inputs?.["mode"] === "refresh-pr"),
);
const steps = Object.values(workflow.jobs).flatMap(
  ({ steps: jobSteps }) => jobSteps,
);
const REFRESH_PATHS = [
  "packages/catalogue/entries/**/manifest.json",
  "packages/catalogue/src/catalogue.gen.ts",
  "packages/catalogue/src/catalogue-install-payloads.gen.ts",
  "packages/catalogue/upstream/pinned-content.gen.json",
] as const;
const directories: string[] = [];
const byCodeUnit = (left: string | undefined, right: string | undefined) => {
  const a = left ?? "";
  const b = right ?? "";
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
  );
});

type FixtureMode =
  | "advanced"
  | "failed"
  | "out-of-allowlist"
  | "unchanged"
  | "refresh-failed"
  | "validation-failed";
type JobStatus = "success" | "failure";

test("retains least-privilege grants and the reviewed publication identity", () => {
  expect(workflow.permissions).toEqual({});
  for (const job of Object.values(workflow.jobs)) {
    expect(job.permissions).toEqual({ contents: "read" });
  }
  const confinement = v.parse(
    stepSchema,
    steps.find(({ run }) =>
      run?.includes("git status --porcelain --untracked-files=all -- ."),
    ),
  );
  const exclusions = [
    ...v
      .parse(v.string(), confinement.run)
      .matchAll(/:\(exclude,(?:glob|literal)\)([^"\n]+)/gu),
  ].map((match) => match[1]);
  expect(exclusions.toSorted(byCodeUnit)).toEqual(
    [...REFRESH_PATHS].toSorted(byCodeUnit),
  );
  expect(steps.slice(0, 3).map(({ name }) => name)).toEqual([
    "Checkout",
    "Setup Bun",
    "Install dependencies",
  ]);
  expect(
    steps.filter(({ uses }) =>
      uses?.startsWith("actions/create-github-app-token@"),
    ),
  ).toHaveLength(1);
  expect(
    steps.filter(({ uses }) => uses?.includes("/signed-commit@")),
  ).toHaveLength(1);
});

const outputValue = (
  outputs: ReadonlyMap<string, ReadonlyMap<string, string>>,
  reference: string,
): string => {
  const match = /^steps\.(?<step>[^.]+)\.outputs\.(?<output>[^.]+)$/u.exec(
    reference,
  );
  if (!match?.groups) {
    panic(`Unsupported workflow output reference: ${reference}`);
  }
  return (
    outputs
      .get(match.groups["step"] ?? "")
      ?.get(match.groups["output"] ?? "") ?? ""
  );
};

type ShouldRunOptions = {
  condition: string | undefined;
  outputs: ReadonlyMap<string, ReadonlyMap<string, string>>;
  outcomes: ReadonlyMap<string, string>;
  jobStatus: JobStatus;
};

const shouldRun = ({
  condition,
  outputs,
  outcomes,
  jobStatus,
}: ShouldRunOptions): boolean => {
  const expression = condition?.replace(/^\$\{\{\s*|\s*\}\}$/gu, "");
  const clauses =
    expression?.split(/\s*&&\s*/u).map((clause) => clause.trim()) ?? [];
  // GitHub implicitly requires success unless a status function is explicit.
  if (
    jobStatus === "failure" &&
    !clauses.some((clause) =>
      /^(?:!?cancelled|always|success|failure)\(\)$/u.test(clause),
    )
  ) {
    return false;
  }
  return clauses.every((clause) => {
    switch (clause) {
      case "!cancelled()":
      case "always()":
        return true;
      case "cancelled()":
        return false;
      case "success()":
        return jobStatus === "success";
      case "failure()":
        return jobStatus === "failure";
      default:
        break;
    }
    const comparison =
      /^(?<left>\S+)\s*(?<operator>==|!=)\s*'(?<right>[^']*)'$/u.exec(clause);
    if (!comparison?.groups) {
      panic(`Unsupported workflow condition: ${clause}`);
    }
    const left = comparison.groups["left"] ?? "";
    let actual: string;
    if (left.startsWith("steps.") && left.endsWith(".outcome")) {
      actual = outcomes.get(left.split(".")[1] ?? "") ?? "";
    } else if (left.startsWith("steps.")) {
      actual = outputValue(outputs, left);
    } else if (left === "github.repository") {
      actual = "stella/stella";
    } else if (left === "github.ref") {
      actual = "refs/heads/main";
    } else {
      return panic(`Unsupported workflow condition input: ${left}`);
    }
    return comparison.groups["operator"] === "=="
      ? actual === comparison.groups["right"]
      : actual !== comparison.groups["right"];
  });
};

const parseOutputFile = async (file: string): Promise<Map<string, string>> => {
  if (!(await Bun.file(file).exists())) {
    return new Map();
  }
  return new Map(
    (await Bun.file(file).text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
};

const runWorkflow = async (mode: FixtureMode, fixtureSteps = steps) => {
  const root = await mkdtemp(path.join(tmpdir(), "pinned-refresh-"));
  const tools = await mkdtemp(path.join(tmpdir(), "pinned-refresh-tools-"));
  directories.push(root, tools);
  for (const directory of [
    "packages/catalogue/entries/skills/reviewed",
    "packages/catalogue/src",
    "packages/catalogue/upstream",
  ]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }

  const currentRev = "a".repeat(40);
  const latestRev = "b".repeat(40);
  await Bun.write(
    path.join(root, "packages/catalogue/entries/skills/reviewed/manifest.json"),
    `${JSON.stringify({ rev: currentRev })}\n`,
  );
  await Bun.write(
    path.join(root, "packages/catalogue/src/catalogue.gen.ts"),
    "// catalogue\n",
  );
  await Bun.write(
    path.join(root, "packages/catalogue/src/catalogue-install-payloads.gen.ts"),
    "// payloads\n",
  );
  await Bun.write(
    path.join(root, "packages/catalogue/upstream/pinned-content.gen.json"),
    "{}\n",
  );
  for (const command of [
    ["git", "init", "-q"],
    ["git", "add", "."],
    [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ],
  ]) {
    const child = Bun.spawn(command, { cwd: root });
    expect(await child.exited).toBe(0);
  }

  let report: {
    failures: { message: string; repo: string; slug: string }[];
    updates: {
      compareUrl: string;
      currentRev: string;
      latestRev: string;
      manifestPath: string;
      repo: string;
      slug: string;
    }[];
  } = { failures: [], updates: [] };
  if (mode === "advanced") {
    report = {
      failures: [],
      updates: [
        {
          compareUrl: "https://example.test/compare",
          currentRev,
          latestRev,
          manifestPath:
            "packages/catalogue/entries/skills/reviewed/manifest.json",
          repo: "example/reviewed",
          slug: "reviewed",
        },
      ],
    };
  } else if (["failed", "refresh-failed", "validation-failed"].includes(mode)) {
    report = {
      failures: [
        {
          message: "upstream unavailable",
          repo: "example/reviewed",
          slug: "reviewed",
        },
      ],
      updates: [],
    };
  }
  const bun = path.join(tools, "bun");
  await Bun.write(
    bun,
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS_FILE"
case "$*" in
  "packages/catalogue/scripts/check-upstream.ts --json") printf '%s\\n' "$UPSTREAM_FIXTURE" ;;
  "run --filter @stll/catalogue validate") ;;
  "run --filter @stll/catalogue generate")
    printf '%s\\n' '// regenerated catalogue' > packages/catalogue/src/catalogue.gen.ts
    printf '%s\\n' '// regenerated payloads' > packages/catalogue/src/catalogue-install-payloads.gen.ts
    ;;
  "--filter @stll/catalogue refresh-pinned")
    if [[ "$FIXTURE_MODE" == refresh-failed ]]; then exit 23; fi
    if [[ "$FIXTURE_MODE" == advanced ]]; then
      printf '%s\\n' '{"refreshed":true}' > packages/catalogue/upstream/pinned-content.gen.json
    elif [[ "$FIXTURE_MODE" == out-of-allowlist ]]; then
      printf '%s\\n' 'unreviewed' > packages/catalogue/src/unreviewed.ts
    fi
    ;;
  "--filter @stll/catalogue check-pinned")
    if [[ "$FIXTURE_MODE" == validation-failed ]]; then exit 24; fi
    ;;
  *) printf 'Unsupported Bun command: %s\\n' "$*" >&2; exit 64 ;;
esac
`,
  );
  await chmod(bun, 0o755);

  const githubEnvironment = path.join(tools, "environment");
  const outputs = new Map<string, ReadonlyMap<string, string>>();
  const outcomes = new Map<string, string>();
  const published: string[][] = [];
  let exitCode = 0;
  let jobStatus: JobStatus = "success";
  let log = "";

  for (const [index, step] of fixtureSteps.entries()) {
    if (
      index < 3 ||
      !shouldRun({ condition: step.if, outputs, outcomes, jobStatus })
    ) {
      continue;
    }
    if (step.uses?.startsWith("actions/create-github-app-token@")) {
      expect(step.uses).toBe(precedentApp.uses);
      expect(step.with).toEqual(precedentApp.with);
      expect(step.id).toBe("app-token");
      expect(step.if).toContain("github.repository == 'stella/stella'");
      expect(step.if).toContain("github.ref == 'refs/heads/main'");
      if (step.id) {
        outcomes.set(step.id, "success");
      }
      continue;
    }
    if (step.uses?.includes("/signed-commit@")) {
      expect(step.uses).toBe(precedentProposal.uses);
      expect(step.with?.["token"]).toBe(precedentProposal.with?.["token"]);
      expect(step.with?.["mode"]).toBe("refresh-pr");
      expect(step.with?.["branch"]).toBe("catalogue/upstream-revs");
      expect(step.with?.["base"]).toBe("main");
      expect(step.with?.["pr-body"]).toBe(`\${{ steps.body.outputs.pr-body }}`);
      const configuredPaths = v
        .parse(v.string(), step.with?.["paths"])
        .trim()
        .split("\n");
      expect(configuredPaths.toSorted(byCodeUnit)).toEqual(
        [...REFRESH_PATHS].toSorted(byCodeUnit),
      );
      const status = Bun.spawn(
        [
          "git",
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--",
          ...configuredPaths,
        ],
        { cwd: root, stdout: "pipe" },
      );
      const changed = (await new Response(status.stdout).text())
        .trimEnd()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(3));
      expect(await status.exited).toBe(0);
      published.push(changed);
      continue;
    }
    if (!step.run) {
      panic(`Unsupported workflow step: ${step.name}`);
    }

    const outputFile = path.join(tools, `output-${index}`);
    const inheritedEnvironment = await parseOutputFile(githubEnvironment);
    const child = Bun.spawn(["bash", "-e", "-o", "pipefail", "-c", step.run], {
      cwd: root,
      env: {
        ...process.env,
        ...Object.fromEntries(inheritedEnvironment),
        ...step.env,
        PATH: `${tools}${path.delimiter}${process.env["PATH"] ?? ""}`,
        CALLS_FILE: path.join(tools, "calls"),
        FIXTURE_MODE: mode,
        GITHUB_ENV: githubEnvironment,
        GITHUB_OUTPUT: outputFile,
        RUNNER_TEMP: tools,
        UPSTREAM_FIXTURE: JSON.stringify(report),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    log += stdout + stderr;
    if (step.id) {
      outcomes.set(step.id, code === 0 ? "success" : "failure");
      outputs.set(step.id, await parseOutputFile(outputFile));
    }
    if (code !== 0) {
      jobStatus = "failure";
      if (exitCode === 0) {
        exitCode = code;
      }
    }
  }
  return {
    calls: await Bun.file(path.join(tools, "calls")).text(),
    exitCode,
    log,
    published,
  };
};

test.each([
  { mode: "unchanged", exitCode: 0, published: [[]] },
  {
    mode: "advanced",
    exitCode: 0,
    published: [
      REFRESH_PATHS.map((pattern) =>
        pattern.replace("**", "skills/reviewed"),
      ).toSorted(byCodeUnit),
    ],
  },
  { mode: "failed", exitCode: 1, published: [[]] },
  { mode: "out-of-allowlist", exitCode: 1, published: [] },
  { mode: "refresh-failed", exitCode: 23, published: [] },
  { mode: "validation-failed", exitCode: 24, published: [] },
] satisfies { mode: FixtureMode; exitCode: number; published: string[][] }[])(
  "runs the pinned refresh for $mode inputs without publishing unreviewed paths",
  async ({ mode, exitCode, published }) => {
    const result = await runWorkflow(mode);
    expect(result.exitCode, result.log).toBe(exitCode);
    expect(result.published).toEqual(published);
    expect(result.calls).toContain("catalogue refresh-pinned");
    if (mode !== "refresh-failed") {
      expect(
        result.calls
          .split("\n")
          .filter((call) => call === "--filter @stll/catalogue check-pinned"),
      ).toHaveLength(1);
    }
    if (["failed", "refresh-failed", "validation-failed"].includes(mode)) {
      expect(result.log).toContain("upstream unavailable");
    }
    if (mode === "out-of-allowlist") {
      expect(result.log).toContain(
        "The refresh changed files outside catalogue manifests and generated inputs.",
      );
    }
  },
);

test("unknown Bun invocations fail before publication", async () => {
  const fixtureSteps = steps.map((step) =>
    step.run === "bun --filter @stll/catalogue check-pinned"
      ? { ...step, run: "bun --filter @stll/catalogue unknown-pinned-command" }
      : step,
  );
  expect(fixtureSteps).not.toEqual(steps);
  const result = await runWorkflow("unchanged", fixtureSteps);
  expect(result.exitCode).toBe(64);
  expect(result.published).toEqual([]);
  expect(result.log).toContain("Unsupported Bun command");
});
