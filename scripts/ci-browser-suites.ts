#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { cachedForRepository } from "./ci-repository-cache";
import { compareCodeUnit, listE2eSpecs } from "./e2e-spec-shards-core";
import { readPlaygroundInventory } from "./ui-playground-selection";

// Install-free: ci-plan reads the registry before its dependency install.
// The import-graph selection lives in scripts/ci-browser-suite-selection.ts.

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** ci-browser matrix legs that run the changed specs of their suites. */
const CI_BROWSER_LEGS = ["ui"] as const;
export type CiBrowserLeg = (typeof CI_BROWSER_LEGS)[number];

/**
 * How a pull request proves a browser suite before the merge group runs it.
 * - `ci-browser-leg` runs only the suite's selected specs on that leg.
 * - `production-leg` puts the first production e2e leg in the plan, which
 *   runs the whole suite, when the suite has a selected spec.
 * - `playground-selection` and `production-selection` run the specs their
 *   own planners select, which include every changed spec.
 * - `scope` runs the whole suite on the pull request when the same scope
 *   output the merge group reads is true, which a change under its test
 *   directory makes true.
 * - `armed-proof` suites run on the armed pull request whenever the merge
 *   group would run them.
 *
 * Selected specs (scripts/ci-browser-suite-selection.ts): a changed spec, a
 * spec whose static import closure holds a changed module, and every spec
 * when the suite's run inputs change or its closure cannot be read.
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
  /** The ci.yml job that runs the suite in merge groups. */
  job: string;
  /** The workspace package whose script starts Playwright. */
  package: string;
  script: string;
  /** Spec filters every merge-group invocation of this suite passes. */
  filters?: readonly string[];
  /**
   * Files and directories the suite reads outside its specs' imports. Like
   * its package manifest, Playwright config and global setup, a change to
   * one selects every spec of the suite.
   */
  inputs?: readonly string[];
  pr: BrowserSuitePrPath;
};

// Every Playwright invocation reachable from ci.yml belongs to exactly one
// suite here; scripts/ci-browser-suites.test.ts holds the workflow to it.
export const BROWSER_SUITES = [
  {
    id: "ui-components",
    job: "ci-browser",
    package: "@stll/ui",
    script: "test:browser",
    // Specs open these pages through the package's Vite server.
    inputs: [
      "packages/ui/src/components/fixtures",
      "packages/ui/vite.config.ts",
    ],
    pr: { kind: "ci-browser-leg", leg: "ui" },
  },
  {
    id: "extension",
    job: "ci-browser",
    package: "@stll/extension",
    script: "test:e2e",
    // Specs load the extension built from these sources.
    inputs: [
      "apps/extension/src",
      "apps/extension/public",
      "apps/extension/scripts",
      "apps/extension/wxt.config.ts",
      "apps/extension/tsconfig.json",
      "packages/api-contract/src/browser-control.ts",
    ],
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
    // The leg runs the geometry specs its own planner lists.
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
    id: "production-network",
    job: "e2e-production-shard",
    package: "@stll/web",
    script: "test:e2e",
    filters: ["route-smoke.spec.ts"],
    pr: { kind: "production-selection" },
  },
  {
    id: "api-browser",
    job: "e2e-production-shard",
    package: "@stll/api",
    script: "test:e2e:browser",
    // The visual sandbox runtime and routes the specs drive.
    inputs: ["apps/api/src/handlers/visual-sandbox"],
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
    id: "marketing",
    job: "marketing-screenshots",
    package: "@stll/web",
    script: "test:e2e:marketing",
    pr: { kind: "armed-proof" },
  },
  {
    id: "marketing-capture",
    job: "marketing-screenshots",
    package: "@stll/web",
    script: "test:e2e:marketing:update",
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

export type RegisteredSuite = (typeof BROWSER_SUITES)[number];
export type BrowserSuiteId = RegisteredSuite["id"];
export type BrowserSuiteJob = RegisteredSuite["job"];
export type ChangedSpecSuite = Extract<
  RegisteredSuite,
  { pr: { kind: "ci-browser-leg" } | { kind: "production-leg" } }
>;
export type ChangedSpecSuiteId = ChangedSpecSuite["id"];
export type BrowserSuiteSpecs = Partial<Record<ChangedSpecSuiteId, string[]>>;

/** The job that hosts the production e2e legs. */
export const PRODUCTION_JOB = "e2e-production-shard" satisfies BrowserSuiteJob;

export class BrowserSuiteDeclarationError extends Error {
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

export const isBrowserSuiteId = (value: string): value is BrowserSuiteId =>
  BROWSER_SUITES.some((suite) => suite.id === value);

export const browserSuite = (id: BrowserSuiteId): RegisteredSuite =>
  BROWSER_SUITES.find((suite) => suite.id === id) ??
  (() => {
    throw new BrowserSuiteDeclarationError(`Unknown browser suite ${id}`);
  })();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toPosix = (file: string) => file.split(path.sep).join("/");

/** True when `file` is `input` or lies inside the `input` directory. */
export const coveredBy = (file: string, input: string) =>
  file === input || file.startsWith(`${input}/`);

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
  const manifest = path.join(root, directory, "package.json");
  if (!existsSync(manifest)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf-8"));
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
      const config = rest[index + 1];
      if (config === undefined || config.startsWith("-")) {
        throw new BrowserSuiteDeclarationError(
          `Playwright ${word} names no config: ${scriptText}`,
        );
      }
      return config;
    }
    if (word.startsWith("--config=")) {
      return word.slice("--config=".length);
    }
  }
  return "playwright.config.ts";
};

/** The repository path of the Playwright config the suite's script runs. */
export const browserSuiteConfig = (
  suite: BrowserSuite,
  root = REPO_ROOT,
): string => {
  const directory = packageDirectory(suite.package, root);
  const scriptText =
    directory === undefined
      ? undefined
      : packageScript(directory, suite.script, root);
  const config =
    scriptText === undefined ? undefined : playwrightConfigOf(scriptText);
  if (directory === undefined || config === undefined) {
    throw new BrowserSuiteDeclarationError(
      `${suite.package} ${suite.script} does not run Playwright`,
    );
  }
  return path.posix.join(directory, config);
};

const literalValues = (source: string, key: string) => {
  const keys = source.match(new RegExp(String.raw`\b${key}\s*:`, "gu")) ?? [];
  const literals = [
    ...source.matchAll(
      new RegExp(String.raw`\b${key}\s*:\s*(["'])([^"'\n]+)\1`, "gu"),
    ),
  ].map((match) => match[2] ?? "");
  return { keys: keys.length, literals };
};

const configSource = (config: string, root: string) => {
  const absolute = path.join(root, config);
  if (!existsSync(absolute)) {
    throw new BrowserSuiteDeclarationError(
      `Missing Playwright config ${config}`,
    );
  }
  return readFileSync(absolute, "utf-8");
};

/** The one literal value of a config key, or undefined when it is absent. */
const singleLiteral = (config: string, source: string, key: string) => {
  const { keys, literals } = literalValues(source, key);
  if (keys > 1 || literals.length !== keys) {
    throw new BrowserSuiteDeclarationError(
      `${config} must declare ${key} at most once, as a string literal`,
    );
  }
  return literals[0];
};

/** The suite's test directory; the config must name it as one literal. */
export const browserSuiteTestDir = (
  suite: BrowserSuite,
  root = REPO_ROOT,
): string => {
  const config = browserSuiteConfig(suite, root);
  const testDir = singleLiteral(config, configSource(config, root), "testDir");
  return path.posix.join(path.posix.dirname(config), testDir ?? ".");
};

// Playwright's default testMatch: every `.spec` and `.test` script file.
const DEFAULT_TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/u;

type SpecLayout = { testDir: string; matches: (relative: string) => boolean };

// Spec selection lists specs from the config itself, so a config whose test
// files this parser cannot determine fails loudly instead of selecting less.
const specLayout = (suite: BrowserSuite, root: string): SpecLayout => {
  const config = browserSuiteConfig(suite, root);
  const source = configSource(config, root);
  if (/\btestIgnore\b/u.test(source)) {
    throw new BrowserSuiteDeclarationError(`${config} declares testIgnore`);
  }
  if (/\bdefineConfig\s*\(\s*[A-Za-z_$][\w$]*\s*,/u.test(source)) {
    throw new BrowserSuiteDeclarationError(`${config} extends another config`);
  }
  const testMatch = singleLiteral(config, source, "testMatch");
  const glob = testMatch === undefined ? undefined : new Bun.Glob(testMatch);
  return {
    testDir: browserSuiteTestDir(suite, root),
    matches: (relative) =>
      glob === undefined
        ? DEFAULT_TEST_FILE.test(relative)
        : glob.match(relative),
  };
};

const configSpecs = (suite: BrowserSuite, root: string): string[] => {
  const layout = specLayout(suite, root);
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
      !relative.split("/").includes("node_modules") &&
      layout.matches(relative) &&
      statSync(path.join(absolute, entry)).isFile()
    ) {
      specs.push(path.posix.join(layout.testDir, relative));
    }
  }
  return specs;
};

const specInventories = new Map<string, readonly string[]>();

/**
 * The spec files a merge-group invocation of the suite runs. Suites proven
 * by a scope output or the armed run need no inventory and list none, and a
 * checkout without the suite's package has none; the census test proves
 * every registered package resolves in this repository.
 */
export const browserSuiteSpecs = (
  suite: RegisteredSuite,
  root = REPO_ROOT,
): readonly string[] =>
  cachedForRepository(specInventories, { root, key: suite.id }, () => {
    if (packageDirectory(suite.package, root) === undefined) {
      return [];
    }
    const { pr } = suite;
    const filters: readonly string[] = "filters" in suite ? suite.filters : [];
    const filtered = (specs: readonly string[]) =>
      specs
        .filter((spec) => filters.every((filter) => spec.includes(filter)))
        .toSorted(compareCodeUnit);
    switch (pr.kind) {
      case "ci-browser-leg":
      case "production-leg":
        return filtered(configSpecs(suite, root));
      case "playground-selection":
        return filtered(readPlaygroundInventory(root).specs);
      case "production-selection":
        return filtered(listE2eSpecs(root));
      case "scope":
      case "armed-proof":
        return [];
      default: {
        pr satisfies never;
        throw new BrowserSuiteDeclarationError("Unknown browser suite PR path");
      }
    }
  });

const literalPaths = (config: string, source: string, key: string) => {
  const value = singleLiteral(config, source, key);
  return value === undefined
    ? []
    : [
        path.posix.normalize(
          path.posix.join(path.posix.dirname(config), value),
        ),
      ];
};

/**
 * Inputs whose change selects every spec of the suite: its manifest, its
 * Playwright config and global setup, and its declared inputs.
 */
export const browserSuiteRunInputs = (
  suite: RegisteredSuite,
  root = REPO_ROOT,
): readonly string[] => {
  const directory = packageDirectory(suite.package, root);
  if (directory === undefined) {
    return [];
  }
  const config = browserSuiteConfig(suite, root);
  const source = configSource(config, root);
  const declared: readonly string[] = "inputs" in suite ? suite.inputs : [];
  return [
    path.posix.join(directory, "package.json"),
    config,
    ...literalPaths(config, source, "globalSetup"),
    ...literalPaths(config, source, "globalTeardown"),
    ...declared,
  ];
};

/**
 * The changed specs and run inputs of each changed-spec suite, without its
 * import graph; ci-plan reads this before its dependency install.
 */
export const directlyChangedSuiteSpecs = (
  changed: readonly string[],
  root = REPO_ROOT,
): BrowserSuiteSpecs => {
  const files = new Set(changed);
  const selected = CHANGED_SPEC_SUITES.flatMap((suite) => {
    const specs = browserSuiteSpecs(suite, root);
    const inputs = browserSuiteRunInputs(suite, root);
    const all = changed.some((file) =>
      inputs.some((input) => coveredBy(file, input)),
    );
    const chosen = all ? [...specs] : specs.filter((spec) => files.has(spec));
    return chosen.length > 0 ? [[suite.id, chosen] as const] : [];
  });
  const selection: BrowserSuiteSpecs = Object.fromEntries(selected);
  return selection;
};

/** Every spec of every changed-spec suite, for a change set nobody can read. */
export const allChangedSpecSuiteSpecs = (
  root = REPO_ROOT,
): BrowserSuiteSpecs => {
  const selection: BrowserSuiteSpecs = Object.fromEntries(
    CHANGED_SPEC_SUITES.map(
      (suite) => [suite.id, [...browserSuiteSpecs(suite, root)]] as const,
    ),
  );
  return selection;
};

/** The selected specs of every suite a workflow job hosts on the PR. */
export const hostedSuiteSpecs = (
  selection: BrowserSuiteSpecs,
  job: BrowserSuiteJob,
): string[] =>
  CHANGED_SPEC_SUITES.filter((suite) => suite.job === job).flatMap(
    (suite) => selection[suite.id] ?? [],
  );

/** Every spec of the changed-spec suites a workflow job hosts. */
export const hostedSuiteSpecFiles = (
  job: BrowserSuiteJob,
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

/**
 * The specs of `legSpecs` the suite runs on its ci-browser leg. Every spec a
 * leg carries must belong to one of the leg's suites, so the leg's steps
 * together run exactly the specs it carries.
 */
export const legSuiteSpecs = (
  id: BrowserSuiteId,
  leg: string,
  legSpecs: readonly string[],
  root = REPO_ROOT,
): string[] => {
  const hosted = CHANGED_SPEC_SUITES.filter(
    (suite) => suite.pr.kind === "ci-browser-leg" && suite.pr.leg === leg,
  );
  const owned = new Set(
    hosted.flatMap((suite) => browserSuiteSpecs(suite, root)),
  );
  const stray = legSpecs.filter((spec) => !owned.has(spec));
  if (stray.length > 0 || !hosted.some((suite) => suite.id === id)) {
    throw new BrowserSuiteDeclarationError(
      `Leg ${leg} carries specs none of its suites run, or does not host ${id}: ${stray.join(", ")}`,
    );
  }
  const members = new Set(browserSuiteSpecs(browserSuite(id), root));
  return legSpecs.filter((spec) => members.has(spec));
};

if (import.meta.main) {
  const [command, id] = process.argv.slice(2);
  if (command === "plan-all") {
    // Fallback when the import-graph selection cannot run.
    const legs =
      process.env["EVENT_NAME"] === "pull_request"
        ? ciBrowserSuiteLegs(allChangedSpecSuiteSpecs())
        : [];
    process.stdout.write(`legs=${JSON.stringify(legs)}\n`);
  } else if (command === "specs" && id !== undefined && isBrowserSuiteId(id)) {
    const specs = legSuiteSpecs(
      id,
      process.env["LEG"] ?? "",
      specList(JSON.parse(process.env["LEG_SPECS"] ?? "[]")),
    );
    for (const spec of specs) {
      console.log(spec);
    }
  } else {
    throw new BrowserSuiteDeclarationError(
      "Usage: ci-browser-suites.ts plan-all | specs <suite>",
    );
  }
}
