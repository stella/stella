import { panic, Result } from "better-result";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";

import { listApiTestPaths } from "../apps/api/scripts/api-test-plan";
import { partitionTestFiles } from "../apps/api/scripts/test-file-shards";
import {
  API_TEST_DURATIONS_FILE_ENV,
  loadTestDurationWeights,
} from "../apps/api/scripts/test-timings";
import { parseSource, walk } from "../packages/scripts/src/syntax-tree";
import { API_TEST_SHARD_IDS } from "./api-test-shard-plan";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..");
const MAX_SHARDS = API_TEST_SHARD_IDS.length;
export const API_SHARD_SECONDS = 600;
const MODULE_PATTERN = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

// Each rule has a regression case; broad configuration changes certify the full suite.
export const API_ALL_RULES = {
  manifest: /(?:^|\/)package\.json$/u,
  lockfile: /(?:^|\/)bun\.lockb?$/u,
  typescript: /(?:^|\/)tsconfig[^/]*$/u,
  bun: /(?:^|\/)bunfig\.toml$/u,
  npm: /(?:^|\/)\.npmrc$/u,
  turbo: /(?:^|\/)turbo\.json$/u,
  patches: /^patches\//u,
  // Keep this list aligned with the local actions used by the API-running jobs
  // in ci.yml. api-test-impact.test.ts fails when a new action is wired there.
  github:
    /^\.github\/(?:workflows\/ci\.yml|actions\/(?:ci-install|flaky-test-quarantine)(?:\/.*)?)$/u,
  migrations: /^apps\/api\/drizzle\//u,
  database: /^apps\/api\/src\/db\//u,
  runner: /^apps\/api\/scripts\//u,
  selector:
    /^(?:scripts\/(?:test-scope|test-shards|api-test-impact|ci-api-test-plan|ci-postgres-test-plan|ci-postgres-shard-plan|ci-postgres-selector-miss)\.(?:test\.)?ts|packages\/scripts\/src\/test-shard-planning\.ts)$/u,
  environment: /^apps\/api\/\.env/u,
  postgres: /^docker\/postgres\//u,
  data: /^(?:apps\/api|packages)\/(?!.*\.(?:[cm]?[jt]s|[jt]sx)$)/u,
} as const;

// Turbo owns cross-workspace test inputs. Matching one must widen before
// the import graph, which cannot observe arbitrary root-level file readers.
const apiExternalInputs = (root: string): string[] => {
  const turbo = v.parse(
    v.object({
      tasks: v.object({
        "@stll/api#test": v.object({ inputs: v.array(v.string()) }),
      }),
    }),
    Bun.JSONC.parse(readFileSync(path.join(root, "turbo.json"), "utf-8")),
  );
  const external: string[] = [];
  for (const input of turbo.tasks["@stll/api#test"].inputs) {
    if (input === "$TURBO_DEFAULT$" || input.startsWith("!")) {
      continue;
    }
    const pattern = input.startsWith("$TURBO_ROOT$/")
      ? path.posix.normalize(input.slice("$TURBO_ROOT$/".length))
      : path.posix.join("apps/api", input);
    if (pattern.includes("$") || path.posix.isAbsolute(pattern)) {
      panic(`Unknown API test input: ${input}`);
    }
    if (pattern !== "apps/api" && !pattern.startsWith("apps/api/")) {
      external.push(pattern);
    }
  }
  return external;
};

export type ApiTestImpact = {
  mode: "all" | "selected" | "none";
  files: string[];
  shards: number;
};
export const allApiTests = (): ApiTestImpact => ({
  mode: "all",
  files: [],
  shards: MAX_SHARDS,
});

const exportTarget = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  // Conditional exports use declaration order, not a preferred-condition order.
  for (const [condition, entry] of Object.entries(value)) {
    if (!["bun", "import", "node", "default"].includes(condition)) {
      continue;
    }
    const target = exportTarget(entry);
    if (target !== undefined) {
      return target;
    }
  }
  return undefined;
};

const workspaceExports = (root: string) => {
  const packages = new Map<string, { directory: string; exports: unknown }>();
  for (const workspace of ["apps", "packages"]) {
    const directory = path.join(root, workspace);
    if (!existsSync(directory)) {
      continue;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifest = path.join(directory, entry.name, "package.json");
      if (!existsSync(manifest)) {
        continue;
      }
      const json: unknown = JSON.parse(readFileSync(manifest, "utf-8"));
      if (typeof json !== "object" || json === null) {
        panic(`Invalid manifest: ${manifest}`);
      }
      const name: unknown = Reflect.get(json, "name");
      if (typeof name !== "string") {
        panic(`Missing workspace name: ${manifest}`);
      }
      packages.set(name, {
        directory: path.dirname(manifest),
        exports: Reflect.get(json, "exports"),
      });
    }
  }
  return packages;
};

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
  js: new Bun.Transpiler({ loader: "jsx" }),
};

const READER_PATTERN =
  /\b(?:readFile(?:Sync)?|readdir(?:Sync)?|Glob)\b|\bBun\s*\.\s*file\b/u;
// Computed imports cannot appear in scanImports; directory scanners and
// computed module loaders therefore run whenever source files change.
const SCANNER_PATTERN =
  /\b(?:readdir(?:Sync)?|Glob|glob)\b|import\.meta\.glob|\b(?:import|require)\s*\(\s*[^"'\s]/u;

// Any call of import() or require() needs one of these in the raw text: the
// keyword before a parenthesis or a comment, or a Unicode escape that can
// spell either keyword. Other modules skip the syntax tree.
const LOADER_CALL_PATTERN = /\b(?:import|require)\s*(?:\(|\/[*/])|\\u/u;

type ModuleReach = "all" | ReadonlySet<string>;

const TEXT_REACH_PREFILTER =
  /\b(?:REPOSITORY_ROOT|repoRoot|repositoryRoot|workspaceRoot)\b|process\s*\.\s*cwd|apps\/(?!api\/)|["'`]apps\/?["'`]|\.\.\/|["'`]\.\.["'`]/u;

// Module specifiers are not paths a test reads; strip them cheaply before
// the prefilter so only modules with other path text are parsed.
const withoutModuleSpecifiers = (source: string): string =>
  source
    .replaceAll(/\b(?:from|import)\s*["'`][^"'`\n]*["'`]/gu, "")
    .replaceAll(/\b(?:import|require)\s*\(\s*["'`][^"'`\n]*["'`]\s*\)/gu, "");

const mayHaveTextReach = (source: string): boolean =>
  TEXT_REACH_PREFILTER.test(withoutModuleSpecifiers(source));

// App names are recorded as written; selection compares them with the apps a
// change touches, so a name that is not an app never selects anything.
const textReach = (file: string, source: string): ModuleReach => {
  if (!mayHaveTextReach(source)) {
    return new Set();
  }
  // `source` is transpiled code: comments are gone and import syntax is
  // normalized, so module specifiers can be removed without a parse.
  const code = withoutModuleSpecifiers(source);
  if (
    /\b(?:REPOSITORY_ROOT|repoRoot|repositoryRoot|workspaceRoot)\b/u.test(
      code,
    ) ||
    /process\s*\.\s*cwd\s*\(/u.test(code) ||
    /apps\/(?:\*|\*\*|\{[^}/]+\}|\$\{)(?=\/|["'`]|$|[^/]*\})/u.test(code) ||
    // A path assembled from segments (`path.join("apps", name)`) can name
    // any app.
    /["'`]apps\/?["'`]/u.test(code)
  ) {
    return "all";
  }
  // A climb leaves the module's own workspace only when it climbs past that
  // workspace's root: `../../..` from `apps/api/src/lib/x/` stays in
  // `apps/api`. Counted from `../` runs and from `".."` call arguments.
  const climbs: string[][] = [
    ...[...code.matchAll(/((?:\.\.\/)+)([^/'"`$}\s]*)/gu)].map((match) => [
      ...Array.from({ length: (match[1] ?? "").length / 3 }, () => ".."),
      match[2] ?? "",
    ]),
    // A `join`/`resolve` call's quoted segments, in order, from the module's
    // directory; the arguments are read with balanced parentheses so a nested
    // call (`join(dirname(x), "..", "web")`) keeps them.
    ...[...code.matchAll(/\b(?:join|resolve)\s*\(/gu)].map((match) => {
      const start = match.index + match[0].length;
      let depth = 1;
      let end = start;
      while (end < code.length && depth > 0) {
        if (code[end] === "(") {
          depth += 1;
        } else if (code[end] === ")") {
          depth -= 1;
        }
        end += 1;
      }
      return [
        ...code.slice(start, end - 1).matchAll(/["'`]([^"'`]*)["'`]/gu),
      ].map((literal) => literal[1] ?? "");
    }),
  ].filter((segments) =>
    segments.some((segment) => segment.split("/").includes("..")),
  );
  const workspace = /^(?:apps|packages)\/[^/]+/u.exec(file)?.[0];
  const apps = new Set<string>();
  for (const segments of climbs) {
    const target = path.posix.join(path.posix.dirname(file), ...segments);
    if (
      workspace !== undefined &&
      (target === workspace || target.startsWith(`${workspace}/`))
    ) {
      continue;
    }
    const app = /^apps\/([^/]+)/u.exec(target)?.[1];
    if (app === undefined || app === "api") {
      return "all";
    }
    apps.add(app);
  }
  for (const match of code.matchAll(
    /(?:apps\/|\.\.\/)([^/'"`$}\s]+)(?=\/|["'`]|$)/gu,
  )) {
    const app = match[1];
    // A glob character anywhere in the app segment (`apps/web*`) can match
    // any app name.
    if (app !== undefined && /[*?[{]/u.test(app)) {
      return "all";
    }
    if (app !== undefined && app !== "api" && app !== "..") {
      apps.add(app);
    }
  }
  return apps;
};

/**
 * Reads a module for the import graph: its static imports and whether its
 * code (not its comments) reads files or scans directories, so prose that
 * mentions a glob cannot mark a hub module as a scanner and widen every plan
 * through it. Only sources whose raw text matches are transpiled, which keeps
 * the graph fast. The transpiler rejects a leading shebang that Bun itself
 * runs, and one unscannable module widens every failure-strict plan to the
 * full suite, so strip it first.
 */
export const analyzeModule = (file: string, source: string) => {
  let transpiler = transpilers.js;
  if (file.endsWith(".tsx")) {
    transpiler = transpilers.tsx;
  } else if (/\.[cm]?ts$/u.test(file)) {
    transpiler = transpilers.ts;
  }
  const runnable = source.replace(/^#![^\n]*/u, "");
  const imports = transpiler.scanImports(runnable);
  const mentionsReads = READER_PATTERN.test(runnable);
  const mentionsScans = SCANNER_PATTERN.test(runnable);
  const reachCandidate = mayHaveTextReach(runnable);
  const shouldTransform = mentionsReads || mentionsScans || reachCandidate;
  const code = shouldTransform ? transpiler.transformSync(runnable) : "";
  let computedImports = false;
  if (LOADER_CALL_PATTERN.test(runnable) || mentionsReads || mentionsScans) {
    walk(parseSource(file, runnable).program, (node) => {
      if (node.type === "ImportExpression") {
        if (
          node.source.type !== "Literal" ||
          typeof node.source.value !== "string"
        ) {
          computedImports = true;
        }
      } else if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "require"
      ) {
        const specifier = node.arguments.at(0);
        if (
          specifier?.type !== "Literal" ||
          typeof specifier.value !== "string"
        ) {
          computedImports = true;
        }
      }
    });
  }
  return {
    computedImports,
    imports,
    reads: mentionsReads && READER_PATTERN.test(code),
    reach: reachCandidate ? textReach(file, code) : new Set<string>(),
    scans: mentionsScans && SCANNER_PATTERN.test(code),
  };
};

export const buildImportGraph = (
  repositoryRoot: string,
  starts: readonly string[],
) => {
  const root = realpathSync(path.resolve(repositoryRoot));
  const packages = workspaceExports(root);
  const edges = new Map<string, string[]>();
  const readers = new Set<string>();
  const scanners = new Set<string>();
  const reaches = new Map<string, ModuleReach>();
  const failed = new Set<string>();
  const computedImports = new Set<string>();
  const resolveWorkspace = (specifier: string): string | undefined => {
    const name = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/").at(0);
    const pkg = name === undefined ? undefined : packages.get(name);
    if (pkg === undefined || name === undefined) {
      return undefined;
    }
    const key = `.${specifier.slice(name.length)}`;
    const exports = pkg.exports;
    let target = key === "." ? exportTarget(exports) : undefined;
    if (typeof exports === "object" && exports !== null) {
      target ??= exportTarget(Reflect.get(exports, key));
      if (target === undefined) {
        for (const pattern of Object.keys(exports)) {
          const star = pattern.indexOf("*");
          if (
            star === -1 ||
            !key.startsWith(pattern.slice(0, star)) ||
            !key.endsWith(pattern.slice(star + 1))
          ) {
            continue;
          }
          const template = exportTarget(Reflect.get(exports, pattern));
          if (template !== undefined) {
            target = template.replaceAll("*", () =>
              key.slice(star, key.length - (pattern.length - star - 1)),
            );
            break;
          }
        }
      }
    }
    return target === undefined ? undefined : path.join(pkg.directory, target);
  };
  const pending = starts.map((file) => path.join(root, file));
  while (pending.length > 0) {
    const absolute = pending.pop() ?? panic("Graph queue is empty");
    const file = repoRelativePath(root, absolute);
    if (edges.has(file)) {
      continue;
    }
    const dependencies: string[] = [];
    edges.set(file, dependencies);
    if (!MODULE_PATTERN.test(file)) {
      continue;
    }
    const scanned = Result.try(() => {
      const analysis = analyzeModule(file, readFileSync(absolute, "utf-8"));
      const { imports, reach, reads, scans } = analysis;
      if (analysis.computedImports) {
        computedImports.add(file);
      }
      if (reads) {
        readers.add(file);
      }
      if (scans) {
        scanners.add(file);
      }
      reaches.set(file, reach);
      return imports;
    });
    if (scanned.isErr()) {
      failed.add(file);
      continue;
    }
    for (const { path: specifier } of scanned.value) {
      if (
        isBuiltin(specifier) ||
        specifier === "bun" ||
        specifier.startsWith("bun:")
      ) {
        continue;
      }
      const resolution = Result.try(() => {
        const bun = Result.try(() =>
          Bun.resolveSync(specifier, path.dirname(absolute)),
        );
        const resolved = bun.isOk() ? bun.value : resolveWorkspace(specifier);
        if (resolved === undefined) {
          panic(`Cannot resolve ${specifier} from ${file}`);
        }
        if (!path.isAbsolute(resolved)) {
          return undefined;
        }
        let real = realpathSync(resolved);
        // Shared local installs can point workspace links at another checkout.
        // Re-anchor only those packages through this checkout's exports map.
        if (!real.startsWith(`${root}/`)) {
          const workspace = resolveWorkspace(specifier);
          if (workspace !== undefined) {
            real = realpathSync(workspace);
          }
        }
        if (!real.startsWith(`${root}/`) || real.includes("/node_modules/")) {
          return undefined;
        }
        return real;
      });
      if (resolution.isErr()) {
        failed.add(file);
        continue;
      }
      if (resolution.value === undefined) {
        continue;
      }
      dependencies.push(repoRelativePath(root, resolution.value));
      pending.push(resolution.value);
    }
  }
  const closure = (start: string) => {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const file = queue.pop() ?? panic("Closure queue is empty");
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      queue.push(...(edges.get(file) ?? []));
    }
    return seen;
  };
  const dependencies = (file: string): readonly string[] =>
    edges.get(file) ?? [];
  return {
    closure,
    dependencies,
    failed,
    readers,
    reaches,
    scanners,
    computedImports,
  };
};

type SelectApiTestImpactOptions = {
  changed: readonly string[];
  durationPath?: string;
  root?: string;
  graphFailurePolicy?: "affected" | "all";
};

/** A graph or metadata failure must widen selection, including CLI failures. */
export const selectApiTestImpact = ({
  changed,
  durationPath = process.env[API_TEST_DURATIONS_FILE_ENV],
  root = REPOSITORY_ROOT,
  graphFailurePolicy = "affected",
}: SelectApiTestImpactOptions): ApiTestImpact => {
  try {
    if (
      changed.some((file) =>
        Object.values(API_ALL_RULES).some((rule) => rule.test(file)),
      )
    ) {
      return allApiTests();
    }
    const externalInputs = apiExternalInputs(root);
    if (
      changed.some((file) =>
        externalInputs.some((input) => new Bun.Glob(input).match(file)),
      )
    ) {
      return allApiTests();
    }
    const realRoot = realpathSync(root);
    const apiRoot = path.join(realRoot, "apps/api");
    const tests = listApiTestPaths(apiRoot).map((file) => `apps/api/${file}`);
    const preload = "apps/api/src/tests/setup-env.ts";
    // Scan changed modules too: a new/deleted/unparseable module cannot hide
    // behind a graph that only visits existing test dependencies.
    const graph = buildImportGraph(realRoot, [
      ...tests,
      preload,
      ...changed.filter(
        (file) =>
          /^(apps\/api|packages)\//u.test(file) && MODULE_PATTERN.test(file),
      ),
    ]);
    const preloadClosure = graph.closure(preload);
    if (
      (graphFailurePolicy === "all" && graph.failed.size > 0) ||
      [...preloadClosure].some((file) => graph.failed.has(file)) ||
      changed.some((file) => preloadClosure.has(file) || graph.failed.has(file))
    ) {
      return allApiTests();
    }
    const touchesApiOrPackages = changed.some((file) =>
      /^(?:apps\/api|packages)\//u.test(file),
    );
    const changedApps = new Set(
      changed.flatMap((file) => {
        const match = /^apps\/([^/]+)\//u.exec(file);
        return match?.[1] === undefined || match[1] === "api" ? [] : [match[1]];
      }),
    );
    const changedSet = new Set(changed);
    const isFileReader = (file: string) =>
      graph.readers.has(file) || graph.scanners.has(file);
    // Readers and scanners that import each module directly, built once so
    // the per-test check is a set lookup instead of a closure scan.
    const importingReaders = new Map<string, string[]>();
    if (changedApps.size > 0) {
      for (const reader of graph.reaches.keys()) {
        if (!isFileReader(reader)) {
          continue;
        }
        for (const dependency of graph.dependencies(reader)) {
          importingReaders.set(dependency, [
            ...(importingReaders.get(dependency) ?? []),
            reader,
          ]);
        }
      }
    }
    const files = tests
      .filter((test) => {
        const closure = graph.closure(test);
        return (
          [...closure].some((file) => changedSet.has(file)) ||
          (touchesApiOrPackages &&
            [...closure].some(
              (file) =>
                graph.readers.has(file) ||
                graph.scanners.has(file) ||
                graph.failed.has(file),
            )) ||
          (changedApps.size > 0 &&
            [...closure].some(
              (file) => graph.readers.has(file) || graph.scanners.has(file),
            ) &&
            ([...closure].some((file) => graph.failed.has(file)) ||
              [...closure].some((file) => {
                const reach = graph.reaches.get(file);
                // A root path can be built in one module and read in the
                // module that imports it: "all" counts in a reader or
                // scanner and in what one of them imports directly. App
                // names count anywhere in the closure.
                return (
                  (reach === "all" &&
                    (isFileReader(file) ||
                      (importingReaders.get(file) ?? []).some((reader) =>
                        closure.has(reader),
                      ))) ||
                  (reach !== undefined &&
                    reach !== "all" &&
                    [...changedApps].some((app) => reach.has(app)))
                );
              })))
        );
      })
      .map((file) => file.slice("apps/api/".length));
    if (files.length === 0) {
      return { mode: "none", files: [], shards: 0 };
    }
    const durations = loadTestDurationWeights({
      files,
      path: durationPath,
    });
    const seconds = files.reduce(
      (sum, file) =>
        sum +
        (durations[file] ?? panic(`Missing resolved duration for ${file}`)),
      0,
    );
    const shards = Math.min(
      MAX_SHARDS,
      files.length,
      Math.max(1, Math.ceil(seconds / API_SHARD_SECONDS)),
    );
    partitionTestFiles({ files, durations, count: shards }); // Validate measurements before publishing a plan.
    return { mode: "selected", files, shards };
  } catch (error) {
    console.error(
      "API test impact selection failed; using the full suite",
      error,
    );
    return allApiTests();
  }
};

if (import.meta.main) {
  console.log(
    JSON.stringify(selectApiTestImpact({ changed: process.argv.slice(2) })),
  );
}
