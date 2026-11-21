import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as v from "valibot";

const stepSchema = v.object({
  run: v.optional(v.string(), ""),
  "working-directory": v.optional(v.string()),
});
const workflowSchema = v.object({
  jobs: v.record(
    v.string(),
    v.object({
      steps: v.optional(v.array(stepSchema), []),
      defaults: v.optional(
        v.object({
          run: v.optional(
            v.object({ "working-directory": v.optional(v.string()) }),
          ),
        }),
      ),
    }),
  ),
});
const packageSchema = v.object({
  name: v.string(),
  scripts: v.optional(v.record(v.string(), v.string()), {}),
});

/** Resolve CI's actual package commands to their Playwright configs. */
export const ciPlaywrightConfigs = (root: string, workflow: unknown) => {
  const packages = new Map<
    string,
    { directory: string; scripts: Record<string, string> }
  >();
  for (const file of new Bun.Glob("{apps,packages}/*/package.json").scanSync({
    cwd: root,
  })) {
    const value: unknown = JSON.parse(
      readFileSync(path.join(root, file), "utf-8"),
    );
    const pkg = v.parse(packageSchema, value);
    packages.set(pkg.name, {
      directory: path.dirname(file),
      scripts: pkg.scripts,
    });
  }
  const configs = new Set<string>();
  const addConfig = (command: string, directory: string) => {
    const flag = /(?:--config(?:=|\s+)|-c\s+)([^\s]+)/u.exec(command)?.at(1);
    const config = flag?.replace(/^['"]|['"]$/gu, "") ?? "playwright.config.ts";
    if (config.includes("${")) {
      panic(`Cannot resolve dynamic Playwright config: ${config}`);
    }
    configs.add(path.join(directory, config));
  };
  for (const job of Object.values(v.parse(workflowSchema, workflow).jobs)) {
    for (const step of job.steps) {
      const directory =
        step["working-directory"] ??
        job.defaults?.run?.["working-directory"] ??
        /^[\t ]*cd[\t ]+([^\t \r\n]+)/mu.exec(step.run)?.at(1) ??
        ".";
      for (const match of step.run.matchAll(
        /\bbun\s+(?:--filter\s+([^\s]+)\s+)?(?:run\s+)?(test:(?:e2e[\w:-]*|browser))\b/gu,
      )) {
        const name = match.at(1);
        const script = match.at(2) ?? panic("Missing test script");
        const pkg =
          name === undefined
            ? [...packages.values()].find(
                (candidate) =>
                  path.normalize(candidate.directory) ===
                  path.normalize(directory),
              )
            : packages.get(name);
        if (pkg === undefined) {
          panic(`Cannot resolve Playwright package: ${match[0]}`);
        }
        const command =
          pkg.scripts[script] ?? panic(`Missing Playwright script: ${script}`);
        if (!/\bplaywright\s+test\b/u.test(command)) {
          panic(`Test script no longer directly runs Playwright: ${script}`);
        }
        addConfig(command, pkg.directory);
      }
      if (/\bplaywright\s+test\b/u.test(step.run)) {
        addConfig(step.run, directory);
      }
    }
  }
  return [...configs].toSorted();
};

/** Import configuration only; no tests, browsers or web servers are started. */
export const missingJsonReporters = async (
  root: string,
  configs: readonly string[],
) => {
  const previous = process.env["CI"];
  process.env["CI"] = "true";
  try {
    const problems: string[] = [];
    for (const config of configs) {
      const imported: unknown = await import(
        pathToFileURL(path.join(root, config)).href
      );
      const parsed = v.parse(
        v.object({ default: v.object({ reporter: v.optional(v.unknown()) }) }),
        imported,
      );
      const reporter = parsed.default.reporter;
      if (
        !Array.isArray(reporter) ||
        !reporter.some(
          (entry: unknown) => Array.isArray(entry) && entry.at(0) === "json",
        )
      ) {
        problems.push(`${config}: missing JSON reporter in CI`);
      }
    }
    return problems;
  } finally {
    if (previous === undefined) {
      delete process.env["CI"];
    } else {
      process.env["CI"] = previous;
    }
  }
};

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, "..");
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
  );
  const configs = ciPlaywrightConfigs(root, workflow);
  if (configs.length === 0) {
    panic("CI selects no Playwright configurations");
  }
  const problems = await missingJsonReporters(root, configs);
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    process.exit(1);
  }
  console.log(
    `${configs.length} CI Playwright configurations declare JSON reporters`,
  );
}
