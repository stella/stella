#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { cachedForRepository } from "./ci-repository-cache";
import { sourceImportClosure } from "./detect-route-smoke-changes";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** ci-browser matrix legs that run the changed specs of their suites. */
const CI_BROWSER_LEGS = ["ui"] as const;
export type CiBrowserLeg = (typeof CI_BROWSER_LEGS)[number];

/**
 * How a pull request proves a browser suite before the merge group runs it.
 * - `ci-browser-leg` and `production-leg` run only the suite's changed specs
 *   (a spec, or a module in a spec's static import closure, changed).
 * - `playground-selection` and `production-selection` run the specs their
 *   own planners select, which include every changed spec.
 * - `scope` runs the whole suite on the pull request when the same scope
 *   output the merge group reads is true, which a changed spec makes true.
 * - `armed-proof` suites run on the armed pull request before it is queued.
 */
export type BrowserSuitePrPath =
  | { kind: "ci-browser-leg"; leg: CiBrowserLeg }
  | { kind: "production-leg" }
  | { kind: "playground-selection" }
  | { kind: "production-selection" }
  | {
      kind: "scope";
      output: "desktop_browser_required" | "e2e_landing_required";
    }
  | { kind: "armed-proof" };

export type BrowserSuite = {
  id: string;
  /** The workflow job that runs the suite in merge groups. */
  job: string;
  /** The workspace package whose script starts Playwright. */
  package: string;
  script: string;
  /** Spec filters every merge-group invocation of this suite passes. */
  filters?: readonly string[];
  pr: BrowserSuitePrPath;
};

// Every Playwright invocation in ci.yml belongs to exactly one suite here;
// scripts/ci-browser-suites.test.ts holds the workflow to that census.
export const BROWSER_SUITES = [
  {
    id: "ui-components",
    job: "ci-browser",
    package: "@stll/ui",
    script: "test:browser",
    pr: { kind: "ci-browser-leg", leg: "ui" },
  },
  {
    id: "extension",
    job: "ci-browser",
    package: "@stll/extension",
    script: "test:e2e",
    pr: { kind: "ci-browser-leg", leg: "ui" },
  },
  {
    id: "desktop",
    job: "ci-browser",
    package: "@stll/desktop",
    script: "test:browser",
    pr: { kind: "scope", output: "desktop_browser_required" },
  },
  {
    id: "ui-playground",
    job: "ci-browser",
    package: "@stll/web",
    script: "test:e2e:ui-playground",
    // The leg passes only the geometry specs it plans.
    filters: [".geometry.spec.ts"],
    pr: { kind: "playground-selection" },
  },
  {
    id: "route-smoke",
    job: "route-smoke",
    package: "@stll/web",
    script: "test:e2e",
    filters: ["route-smoke.spec.ts"],
    pr: { kind: "production-selection" },
  },
  {
    id: "production",
    job: "e2e-production-shard",
    package: "@stll/web",
    script: "test:e2e",
    pr: { kind: "production-selection" },
  },
  {
    id: "api-browser",
    job: "e2e-production-shard",
    package: "@stll/api",
    script: "test:e2e:browser",
    pr: { kind: "production-leg" },
  },
  {
    id: "vite-canary",
    job: "e2e-vite-canary",
    package: "@stll/web",
    script: "test:e2e",
    filters: ["e2e/specs/vite-dependency-canary.spec.ts"],
    pr: { kind: "production-selection" },
  },
  {
    id: "anonymized-export",
    job: "e2e-vite-canary",
    package: "@stll/web",
    script: "test:e2e:anonymized-export",
    pr: { kind: "armed-proof" },
  },
  {
    id: "collab",
    job: "e2e-vite-canary",
    package: "@stll/web",
    script: "test:e2e:collab",
    pr: { kind: "armed-proof" },
  },
  {
    id: "stack-redaction",
    job: "stack-redaction-browsers",
    package: "@stll/web",
    script: "test:e2e:stack-redaction",
    pr: { kind: "armed-proof" },
  },
  {
    id: "landing",
    job: "e2e-landing",
    package: "@stll/landing",
    script: "test:e2e",
    pr: { kind: "scope", output: "e2e_landing_required" },
  },
] as const satisfies readonly BrowserSuite[];

type RegisteredSuite = (typeof BROWSER_SUITES)[number];
export type BrowserSuiteId = RegisteredSuite["id"];
type ChangedSpecSuite = Extract<
  RegisteredSuite,
  { pr: { kind: "ci-browser-leg" } | { kind: "production-leg" } }
>;
export type ChangedSpecSuiteId = ChangedSpecSuite["id"];
export type BrowserSuiteSpecs = Partial<Record<ChangedSpecSuiteId, string[]>>;

class BrowserSuiteDeclarationError extends Error {
  override name = "BrowserSuiteDeclarationError";
  readonly _tag = "BrowserSuiteDeclarationError";
}

export const runsChangedSpecs = (
  suite: RegisteredSuite,
): suite is ChangedSpecSuite => {
  const { pr } = suite;
  switch (pr.kind) {
    case "ci-browser-leg":
    case "production-leg":
      return true;
    case "playground-selection":
    case "production-selection":
    case "scope":
    case "armed-proof":
      return false;
    default: {
      pr satisfies never;
      throw new BrowserSuiteDeclarationError("Unknown browser suite PR path");
    }
  }
};

export const CHANGED_SPEC_SUITES: readonly ChangedSpecSuite[] =
  BROWSER_SUITES.filter(runsChangedSpecs);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toPosix = (file: string) => file.split(path.sep).join("/");

const packageDirectories = new Map<string, ReadonlyMap<string, string>>();
const workspacePackages = (root: string): ReadonlyMap<string, string> =>
  cachedForRepository(packageDirectories, { root, key: root }, () => {
    const directories = new Map<string, string>();
    for (const parent of ["apps", "packages"]) {
      const absolute = path.join(root, parent);
      if (!existsSync(absolute)) {
        continue;
      }
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        const manifest = path.join(absolute, entry.name, "package.json");
        if (!entry.isDirectory() || !existsSync(manifest)) {
          continue;
        }
        const parsed: unknown = JSON.parse(readFileSync(manifest, "utf-8"));
        if (isRecord(parsed) && typeof parsed["name"] === "string") {
          directories.set(parsed["name"], `${parent}/${entry.name}`);
        }
      }
    }
    return directories;
  });

/** The repository directory of a workspace package, by its name. */
export const packageDirectory = (name: string, root = REPO_ROOT) =>
  workspacePackages(root).get(name);

/** The package script's text, when the package declares it. */
export const packageScript = (
  directory: string,
  script: string,
  root = REPO_ROOT,
): string | undefined => {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(root, directory, "package.json"), "utf-8"),
  );
  const scripts = isRecord(parsed) ? parsed["scripts"] : undefined;
  const text = isRecord(scripts) ? scripts[script] : undefined;
  return typeof text === "string" ? text : undefined;
};

/** The Playwright config a script runs, or undefined when it runs none. */
export const playwrightConfigOf = (scriptText: string): string | undefined => {
  const words = scriptText.split(/\s+/u).filter((word) => word !== "");
  const start = words.findIndex(
    (word, index) => word === "playwright" && words[index + 1] === "test",
  );
  if (start === -1) {
    return undefined;
  }
  const rest = words.slice(start + 2);
  for (const [index, word] of rest.entries()) {
    if (word === "--config" || word === "-c") {
      return rest[index + 1];
    }
    if (word.startsWith("--config=")) {
      return word.slice("--config=".length);
    }
  }
  return "playwright.config.ts";
};

// Playwright's default testMatch: every `.spec` and `.test` script file.
const DEFAULT_TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/u;

type SpecLayout = { testDir: string; matches: (relative: string) => boolean };

// A checkout without the suite's package, script or config has none of its
// specs; the census test proves every registered suite resolves here.
const specLayout = (
  suite: BrowserSuite,
  root: string,
): SpecLayout | undefined => {
  const directory = packageDirectory(suite.package, root);
  if (directory === undefined) {
    return undefined;
  }
  const scriptText = packageScript(directory, suite.script, root);
  const config =
    scriptText === undefined ? undefined : playwrightConfigOf(scriptText);
  const configPath =
    config === undefined ? undefined : path.posix.join(directory, config);
  if (configPath === undefined || !existsSync(path.join(root, configPath))) {
    return undefined;
  }
  const source = readFileSync(path.join(root, configPath), "utf-8");
  const testDir = /\btestDir:\s*["']([^"']+)["']/u.exec(source)?.[1] ?? ".";
  const testMatch = /\btestMatch:\s*["']([^"']+)["']/u.exec(source)?.[1];
  const glob = testMatch === undefined ? undefined : new Bun.Glob(testMatch);
  return {
    testDir: path.posix.join(path.posix.dirname(configPath), testDir),
    matches: (relative) =>
      glob === undefined
        ? DEFAULT_TEST_FILE.test(relative)
        : glob.match(relative),
  };
};

const specInventories = new Map<string, readonly string[]>();

/** Every spec file a merge-group invocation of the suite runs. */
export const browserSuiteSpecs = (
  suite: BrowserSuite,
  root = REPO_ROOT,
): readonly string[] =>
  cachedForRepository(specInventories, { root, key: suite.id }, () => {
    const layout = specLayout(suite, root);
    if (layout === undefined) {
      return [];
    }
    const absolute = path.join(root, layout.testDir);
    if (!existsSync(absolute)) {
      return [];
    }
    const specs: string[] = [];
    for (const entry of readdirSync(absolute, {
      recursive: true,
      encoding: "utf-8",
    })) {
      const relative = toPosix(entry);
      if (
        relative.split("/").includes("node_modules") ||
        !layout.matches(relative) ||
        !statSync(path.join(absolute, entry)).isFile()
      ) {
        continue;
      }
      const spec = path.posix.join(layout.testDir, relative);
      const filters = suite.filters ?? [];
      if (filters.every((filter) => spec.includes(filter))) {
        specs.push(spec);
      }
    }
    return specs.toSorted();
  });

const closures = new Map<string, ReadonlySet<string>>();
const specClosure = (spec: string, root: string) =>
  cachedForRepository(closures, { root, key: spec }, () =>
    sourceImportClosure([spec], root),
  );

/**
 * The specs of each changed-spec suite a pull request runs: the specs that
 * changed, and the specs whose static import closure holds a changed module.
 * `all` selects every spec, for a change set that cannot be read.
 */
export const changedBrowserSuiteSpecs = (
  changed: readonly string[],
  {
    root = REPO_ROOT,
    all = false,
  }: { root?: string | undefined; all?: boolean | undefined } = {},
): BrowserSuiteSpecs => {
  const files = new Set(changed);
  const selected = CHANGED_SPEC_SUITES.flatMap((suite) => {
    const specs = browserSuiteSpecs(suite, root).filter(
      (spec) =>
        all ||
        files.has(spec) ||
        [...specClosure(spec, root)].some((file) => files.has(file)),
    );
    return specs.length > 0 ? [[suite.id, specs] as const] : [];
  });
  const selection: BrowserSuiteSpecs = Object.fromEntries(selected);
  return selection;
};

/** The changed specs of every suite a workflow job hosts on the PR. */
export const hostedSuiteSpecs = (
  selection: BrowserSuiteSpecs,
  job: string,
): string[] =>
  CHANGED_SPEC_SUITES.filter((suite) => suite.job === job).flatMap(
    (suite) => selection[suite.id] ?? [],
  );

/** Every spec of the changed-spec suites a workflow job hosts. */
export const hostedSuiteSpecFiles = (
  job: string,
  root = REPO_ROOT,
): ReadonlySet<string> =>
  new Set(
    CHANGED_SPEC_SUITES.filter((suite) => suite.job === job).flatMap((suite) =>
      browserSuiteSpecs(suite, root),
    ),
  );

export type CiBrowserSuiteLeg = { suite: CiBrowserLeg; specs: string[] };

/** ci-browser matrix legs that run the selected changed specs. */
export const ciBrowserSuiteLegs = (
  selection: BrowserSuiteSpecs,
): CiBrowserSuiteLeg[] => {
  const legs = new Map<CiBrowserLeg, string[]>();
  for (const suite of CHANGED_SPEC_SUITES) {
    const specs = selection[suite.id];
    if (suite.pr.kind !== "ci-browser-leg" || specs === undefined) {
      continue;
    }
    legs.set(suite.pr.leg, [...(legs.get(suite.pr.leg) ?? []), ...specs]);
  }
  return [...legs].map(([suite, specs]) => ({ suite, specs }));
};

const specList = (parsed: unknown): string[] => {
  if (
    !Array.isArray(parsed) ||
    !parsed.every((spec): spec is string => typeof spec === "string")
  ) {
    throw new BrowserSuiteDeclarationError("Specs must be a JSON string array");
  }
  return parsed;
};

const isCiBrowserLeg = (value: unknown): value is CiBrowserLeg =>
  CI_BROWSER_LEGS.some((leg) => leg === value);

export const parseCiBrowserSuiteLegs = (value: string): CiBrowserSuiteLeg[] => {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new BrowserSuiteDeclarationError("Browser suite legs must be a list");
  }
  return parsed.map((leg: unknown) => {
    if (!isRecord(leg) || !isCiBrowserLeg(leg["suite"])) {
      throw new BrowserSuiteDeclarationError("Invalid browser suite leg");
    }
    return { suite: leg["suite"], specs: specList(leg["specs"]) };
  });
};

const suiteById = (id: string): RegisteredSuite =>
  BROWSER_SUITES.find((suite) => suite.id === id) ??
  (() => {
    throw new BrowserSuiteDeclarationError(`Unknown browser suite ${id}`);
  })();

/** The members of `specs` that belong to the suite. */
export const suiteMembers = (
  id: string,
  specs: readonly string[],
  root = REPO_ROOT,
): string[] => {
  const owned = new Set(browserSuiteSpecs(suiteById(id), root));
  return specs.filter((spec) => owned.has(spec));
};

const readChangedPaths = (file: string | undefined) =>
  file === undefined || !existsSync(file)
    ? []
    : readFileSync(file, "utf-8").split("\0").filter(Boolean);

if (import.meta.main) {
  const [command, suite] = process.argv.slice(2);
  if (command === "plan") {
    const selection =
      process.env["EVENT_NAME"] === "pull_request"
        ? changedBrowserSuiteSpecs(
            readChangedPaths(process.env["BROWSER_SUITE_CHANGED_PATHS"]),
            { all: process.env["SCOPE_UNKNOWN"] === "true" },
          )
        : {};
    process.stdout.write(
      `legs=${JSON.stringify(ciBrowserSuiteLegs(selection))}\n`,
    );
  } else if (command === "specs" && suite !== undefined) {
    const specs = specList(JSON.parse(process.env["LEG_SPECS"] ?? "[]"));
    for (const spec of suiteMembers(suite, specs)) {
      console.log(spec);
    }
  } else {
    throw new BrowserSuiteDeclarationError(
      "Usage: ci-browser-suites.ts plan | specs <suite>",
    );
  }
}
