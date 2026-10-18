import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as v from "valibot";

import {
  loadGlobalRuleInputs,
  matchesGlobalRuleInput,
} from "./global-rule-inputs";
import { workflowJobSteps } from "./workflow-steps";

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

// Pooled checks (.github/ci-checks/*.yml) are steps of their job, so read jobs
// through the workflow-steps owner rather than the raw ci.yml step list.
const getRunCommands = () => {
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(new URL(".github/workflows/ci.yml", REPOSITORY_ROOT), "utf-8"),
  );
  const parsed = v.parse(
    v.looseObject({ jobs: v.record(v.string(), v.unknown()) }),
    workflow,
  );
  return Object.keys(parsed.jobs)
    .filter(
      (name) =>
        STATIC_CHECK_JOB_ROOTS.some((root) => root === name) ||
        STATIC_CHECK_JOB_PREFIXES.some((prefix) => name.startsWith(prefix)),
    )
    .flatMap((name) =>
      workflowJobSteps(workflow, name).flatMap(({ run }) =>
        typeof run === "string" ? [run] : [],
      ),
    );
};

const transpiler = new Bun.Transpiler({ loader: "ts" });

// A check's verdict also depends on the repository modules it imports (a
// gate table, an env catalog), so those are rule inputs as much as the
// script the workflow names.
const withRelativeImports = (paths: readonly string[]) => {
  const seen = new Set(paths);
  const pending = [...paths];
  for (const file of pending) {
    // A glob in a command is scope-checked as written; only files have imports.
    if (!file.endsWith(".ts") || !existsSync(new URL(file, REPOSITORY_ROOT))) {
      continue;
    }
    const source = readFileSync(new URL(file, REPOSITORY_ROOT), "utf-8");
    for (const { path: specifier } of transpiler.scanImports(source)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const target = decodeURIComponent(
        new URL(specifier, new URL(file, REPOSITORY_ROOT)).pathname,
      ).slice(decodeURIComponent(REPOSITORY_ROOT.pathname).length);
      const resolved = [target, `${target}.ts`].find(
        (candidate) =>
          candidate.endsWith(".ts") &&
          existsSync(new URL(candidate, REPOSITORY_ROOT)),
      );
      if (resolved !== undefined && !seen.has(resolved)) {
        seen.add(resolved);
        pending.push(resolved);
      }
    }
  }
  return [...seen].toSorted();
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
    const inputs = loadGlobalRuleInputs();
    const changeScoped = new Set(inputs.changeScoped.map(({ path }) => path));
    const scripts = withRelativeImports(collectScriptPaths(getRunCommands()));
    const unclassified = scripts.filter(
      (path) =>
        !matchesGlobalRuleInput(path, inputs) && !changeScoped.has(path),
    );
    expect(unclassified).toEqual([]);
  });
});
