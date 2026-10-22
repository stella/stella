import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const stepSchema = v.looseObject({
  id: v.optional(v.string()),
  if: v.optional(v.string()),
  run: v.optional(v.string()),
  uses: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
  env: v.optional(v.record(v.string(), v.string())),
});

const workflow = v.parse(
  v.looseObject({
    jobs: v.record(v.string(), v.looseObject({ steps: v.array(stepSchema) })),
  }),
  Bun.YAML.parse(
    await Bun.file(
      new URL(
        "../../../.github/workflows/catalogue-upstream.yml",
        import.meta.url,
      ),
    ).text(),
  ),
);
const steps = Object.values(workflow.jobs).flatMap(
  ({ steps: jobSteps }) => jobSteps,
);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
  );
});

type FixtureMode = "advanced" | "failed" | "out-of-allowlist" | "unchanged";

const outputValue = (
  outputs: ReadonlyMap<string, ReadonlyMap<string, string>>,
  reference: string,
): string => {
  const match = /^steps\.(?<step>[^.]+)\.outputs\.(?<output>[^.]+)$/u.exec(
    reference,
  );
  if (!match?.groups) {
    throw new Error(`Unsupported workflow output reference: ${reference}`);
  }
  return (
    outputs
      .get(match.groups["step"] ?? "")
      ?.get(match.groups["output"] ?? "") ?? ""
  );
};

const shouldRun = (
  condition: string | undefined,
  outputs: ReadonlyMap<string, ReadonlyMap<string, string>>,
  outcomes: ReadonlyMap<string, string>,
): boolean => {
  if (condition === undefined) {
    return true;
  }
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/gu, "");
  return expression
    .replace(/!?cancelled\(\)\s*&&\s*/gu, "")
    .split(/\s*&&\s*/u)
    .every((clause) => {
      const comparison =
        /^(?<left>\S+)\s*(?<operator>==|!=)\s*'(?<right>[^']*)'$/u.exec(
          clause.trim(),
        );
      if (!comparison?.groups) {
        throw new Error(`Unsupported workflow condition: ${clause}`);
      }
      const left = comparison.groups["left"] ?? "";
      let actual = "";
      if (left.startsWith("steps.") && left.endsWith(".outcome")) {
        actual = outcomes.get(left.split(".")[1] ?? "") ?? "";
      } else if (left.startsWith("steps.")) {
        actual = outputValue(outputs, left);
      } else if (left === "github.repository") {
        actual = "stella/stella";
      } else if (left === "github.ref") {
        actual = "refs/heads/main";
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

const runWorkflow = async (mode: FixtureMode) => {
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
  } else if (mode === "failed") {
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
  *check-upstream.ts*) printf '%s\\n' "$UPSTREAM_FIXTURE" ;;
  *"catalogue generate"*)
    printf '%s\\n' '// regenerated catalogue' > packages/catalogue/src/catalogue.gen.ts
    printf '%s\\n' '// regenerated payloads' > packages/catalogue/src/catalogue-install-payloads.gen.ts
    ;;
  *"catalogue refresh-pinned"*)
    if [[ "$FIXTURE_MODE" == advanced ]]; then
      printf '%s\\n' '{"refreshed":true}' > packages/catalogue/upstream/pinned-content.gen.json
    elif [[ "$FIXTURE_MODE" == out-of-allowlist ]]; then
      printf '%s\\n' 'unreviewed' > packages/catalogue/src/unreviewed.ts
    fi
    ;;
esac
`,
  );
  await chmod(bun, 0o755);

  const githubEnvironment = path.join(tools, "environment");
  const outputs = new Map<string, ReadonlyMap<string, string>>();
  const outcomes = new Map<string, string>();
  const published: string[][] = [];
  let exitCode = 0;
  let log = "";

  for (const [index, step] of steps.entries()) {
    if (index < 3 || !shouldRun(step.if, outputs, outcomes)) {
      continue;
    }
    if (step.uses?.startsWith("actions/create-github-app-token@")) {
      if (step.id) {
        outcomes.set(step.id, "success");
      }
      continue;
    }
    if (step.uses?.includes("/signed-commit@")) {
      const configuredPaths = v
        .parse(v.string(), step.with?.["paths"])
        .trim()
        .split("\n");
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
      continue;
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
      exitCode = code;
      break;
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
      [
        "packages/catalogue/entries/skills/reviewed/manifest.json",
        "packages/catalogue/src/catalogue-install-payloads.gen.ts",
        "packages/catalogue/src/catalogue.gen.ts",
        "packages/catalogue/upstream/pinned-content.gen.json",
      ],
    ],
  },
  { mode: "failed", exitCode: 1, published: [[]] },
  { mode: "out-of-allowlist", exitCode: 1, published: [] },
] satisfies { mode: FixtureMode; exitCode: number; published: string[][] }[])(
  "runs the pinned refresh for $mode inputs without publishing unreviewed paths",
  async ({ mode, exitCode, published }) => {
    const result = await runWorkflow(mode);
    expect(result.exitCode, result.log).toBe(exitCode);
    expect(result.published).toEqual(published);
    expect(result.calls).toContain("catalogue refresh-pinned");
    if (mode === "failed") {
      expect(result.log).toContain("upstream unavailable");
    }
    if (mode === "out-of-allowlist") {
      expect(result.log).toContain(
        "The refresh changed files outside catalogue manifests and generated inputs.",
      );
    }
  },
);
