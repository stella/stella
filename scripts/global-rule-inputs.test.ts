import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import {
  checkPoolJob,
  type ReadCheckPool,
  readCheckPool,
} from "./ci-check-pool-registry";
import {
  loadGlobalRuleInputs,
  matchesGlobalRuleInput,
} from "./global-rule-inputs";

const REPOSITORY_ROOT = new URL("../", import.meta.url);
const STATIC_CHECK_JOB_ROOTS = [
  "ci-quick-checks",
  "ci-checks-policy",
  "ci-checks-rest",
  "ci-checks-generated",
] as const;
const STATIC_CHECK_JOB_PREFIXES = ["code-quality-"] as const;

const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  cwd: REPOSITORY_ROOT,
  encoding: "utf-8",
})
  .split("\0")
  .filter(Boolean);

const getRunCommands = (readPool?: ReadCheckPool) => {
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(new URL(".github/workflows/ci.yml", REPOSITORY_ROOT), "utf-8"),
  );
  const parsed = v.parse(
    v.looseObject({
      jobs: v.record(
        v.string(),
        v.looseObject({
          steps: v.optional(
            v.array(v.looseObject({ run: v.optional(v.string()) })),
            [],
          ),
        }),
      ),
    }),
    workflow,
  );

  return Object.entries(parsed.jobs)
    .filter(
      ([name]) =>
        STATIC_CHECK_JOB_ROOTS.some((root) => root === name) ||
        STATIC_CHECK_JOB_PREFIXES.some((prefix) => name.startsWith(prefix)),
    )
    .flatMap(([, job]) =>
      job.steps.flatMap((step) => {
        const commands = step.run ? [step.run] : [];
        const poolJob = checkPoolJob(step);
        if (poolJob) {
          commands.push(
            ...readCheckPool(poolJob, readPool).map(({ run }) => run),
          );
        }
        return commands;
      }),
    );
};

const collectScriptPaths = (commands: string[]) => {
  const packageJson = v.parse(
    v.looseObject({ scripts: v.record(v.string(), v.string()) }),
    JSON.parse(readFileSync(new URL("package.json", REPOSITORY_ROOT), "utf-8")),
  );
  const pending = [...commands];
  const visitedPackageScripts = new Set<string>();
  const paths = new Set<string>();

  for (const command of pending) {
    for (const match of command.matchAll(/\bbun\s+run\s+([\w:-]+)/gu)) {
      const name = match[1];
      if (!name || visitedPackageScripts.has(name)) {
        continue;
      }
      visitedPackageScripts.add(name);
      const packageCommand = packageJson.scripts[name];
      if (packageCommand) {
        pending.push(packageCommand);
      }
    }

    for (const line of command.split("\n")) {
      if (!/\b(?:bun|bash)\b/u.test(line)) {
        continue;
      }
      for (const match of line.matchAll(
        /(?:^|[\s"'(])((?:scripts|packages\/scripts|apps\/[^/]+\/scripts|\.ai\/shared\/scripts)\/[^\s"');&|\\]+\.(?:ts|mjs|sh))(?=$|[\s"');&|\\])/gu,
      )) {
        const path = match[1];
        if (path && !path.startsWith(".ai/shared/")) {
          paths.add(path);
        }
      }
    }
  }

  return [...paths].toSorted();
};

const getUnclassifiedScriptPaths = (commands: string[]) => {
  const inputs = loadGlobalRuleInputs();
  const changeScoped = new Set(inputs.changeScoped.map(({ path }) => path));
  return collectScriptPaths(commands).filter(
    (path) => !matchesGlobalRuleInput(path, inputs) && !changeScoped.has(path),
  );
};

describe("global rule inputs", () => {
  test("the declaration is valid, ordered, and uses the restricted glob syntax", () => {
    const inputs = loadGlobalRuleInputs();
    expect(inputs.globs).toEqual([...new Set(inputs.globs)].toSorted());
    expect(inputs.changeScoped.map(({ path }) => path)).toEqual(
      [...new Set(inputs.changeScoped.map(({ path }) => path))].toSorted(),
    );
    for (const glob of inputs.globs) {
      expect(glob).not.toMatch(/[?![\]{}\\]/u);
      expect(glob).not.toMatch(/\*{3,}/u);
    }
  });

  test("every declaration matches a tracked file", () => {
    const { changeScoped, globs } = loadGlobalRuleInputs();
    for (const glob of globs) {
      expect(
        trackedFiles.some((path) => new Bun.Glob(glob).match(path)),
      ).toBeTrue();
    }
    for (const { path } of changeScoped) {
      expect(trackedFiles).toContain(path);
    }
  });

  test("all custom lint files and oxlint configurations are global inputs", () => {
    const required = trackedFiles.filter(
      (path) =>
        path.startsWith(".oxlint-plugins/") ||
        /(?:^|\/)oxlint(?:\.[^/]+)*\.config\.(?:json|js|ts)$/u.test(path),
    );
    const missing = required.filter((path) => !matchesGlobalRuleInput(path));
    expect(missing).toEqual([]);
  });

  test("every static-check repository script has an explicit scope", () => {
    expect(getUnclassifiedScriptPaths(getRunCommands())).toEqual([]);
  });

  test("a pooled-check command needs an explicit scope", () => {
    const fixture = `checks:
  - name: Unclassified fixture
    if: \${{ true }}
    run: bun scripts/global-rule-inputs.test.ts
`;
    expect(getUnclassifiedScriptPaths(getRunCommands(() => fixture))).toContain(
      "scripts/global-rule-inputs.test.ts",
    );
  });
});
