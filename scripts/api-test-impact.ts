import { panic, Result } from "better-result";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import ts from "typescript6";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";

import { listApiTestPaths } from "../apps/api/scripts/api-test-plan";
import { partitionTestFiles } from "../apps/api/scripts/test-file-shards";
import {
  API_TEST_DURATIONS_FILE_ENV,
  loadTestDurationWeights,
} from "../apps/api/scripts/test-timings";
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
  github: /^\.github\/(?:workflows\/ci\.yml|actions\/ci-install(?:\/.*)?)$/u,
  migrations: /^apps\/api\/drizzle\//u,
  database: /^apps\/api\/src\/db\//u,
  runner: /^apps\/api\/scripts\//u,
  selector:
    /^scripts\/(?:test-scope|test-shards|api-test-impact|ci-api-test-plan|ci-postgres-test-plan|ci-postgres-selector-miss)\.(?:test\.)?ts$/u,
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

const mergeReach = (current: ModuleReach, next: ModuleReach): ModuleReach => {
  if (current === "all" || next === "all") {
    return "all";
  }
  return new Set([...current, ...next]);
};

const directPathReach = (
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
): ModuleReach | undefined => {
  const text = expression.getText(sourceFile);
  if (
    /\bREPOSITORY_ROOT\b|\b(?:repoRoot|repositoryRoot)\b|process\s*\.\s*cwd\s*\(/u.test(
      text,
    ) ||
    /(?:\.\.\/){3}/u.test(text)
  ) {
    return "all";
  }
  const apps = new Set<string>();
  for (const match of text.matchAll(/(?:apps\/|\.\.\/)([^/'"`$}]+)\//gu)) {
    const app = match[1];
    if (app !== undefined && app !== "api" && app !== "..") {
      apps.add(app);
    }
  }
  if (
    apps.size > 0 ||
    ts.isStringLiteralLike(expression) ||
    (ts.isTemplateExpression(expression) &&
      expression.templateSpans.length === 0) ||
    ts.isMetaProperty(expression) ||
    (ts.isPropertyAccessExpression(expression) &&
      ts.isMetaProperty(expression.expression)) ||
    (ts.isIdentifier(expression) &&
      ["__dirname", "__filename"].includes(expression.text)) ||
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    return apps;
  }
  return undefined;
};

const pathReach = (
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  initializers: ReadonlyMap<string, ts.Expression>,
  seen = new Set<string>(),
): ModuleReach => {
  const direct = directPathReach(expression, sourceFile);
  if (direct !== undefined) {
    return direct;
  }
  if (ts.isIdentifier(expression)) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(expression.text)) {
      return new Set();
    }
    if (seen.has(expression.text)) {
      return "all";
    }
    const initializer = initializers.get(expression.text);
    if (initializer === undefined) {
      return new Set();
    }
    return pathReach(
      initializer,
      sourceFile,
      initializers,
      new Set([...seen, expression.text]),
    );
  }
  if (ts.isTemplateExpression(expression)) {
    let reach: ModuleReach = new Set();
    for (const span of expression.templateSpans) {
      reach = mergeReach(
        reach,
        pathReach(span.expression, sourceFile, initializers, seen),
      );
    }
    return reach;
  }
  if (ts.isConditionalExpression(expression)) {
    return mergeReach(
      pathReach(expression.whenTrue, sourceFile, initializers, seen),
      pathReach(expression.whenFalse, sourceFile, initializers, seen),
    );
  }
  if (ts.isBinaryExpression(expression)) {
    const left = pathReach(expression.left, sourceFile, initializers, seen);
    const right = pathReach(expression.right, sourceFile, initializers, seen);
    if (
      [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
        expression.operatorToken.kind,
      )
    ) {
      // Runtime-configured paths are outside the checkout; the local fallback
      // determines which repository directories this module can inspect.
      if (left === "all" && right !== "all") {
        return right;
      }
      if (right === "all" && left !== "all") {
        return left;
      }
    }
    return mergeReach(left, right);
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return pathReach(expression.expression, sourceFile, initializers, seen);
  }
  if (
    (ts.isCallExpression(expression) || ts.isNewExpression(expression)) &&
    ((ts.isPropertyAccessExpression(expression.expression) &&
      ["join", "resolve", "dirname"].includes(
        expression.expression.name.text,
      )) ||
      expression.expression.getText(sourceFile) === "fileURLToPath" ||
      expression.expression.getText(sourceFile) === "URL")
  ) {
    let reach: ModuleReach = new Set();
    for (const argument of expression.arguments ?? []) {
      reach = mergeReach(
        reach,
        pathReach(argument, sourceFile, initializers, seen),
      );
    }
    return reach;
  }
  // A value whose origin is not visible here may resolve outside apps/api.
  return "all";
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
  const code =
    mentionsReads || mentionsScans ? transpiler.transformSync(runnable) : "";
  let computedImports = false;
  const fileOperationReaches: ModuleReach[] = [];
  const initializers = new Map<string, ts.Expression>();
  const sourceFile = ts.createSourceFile(
    file,
    runnable,
    ts.ScriptTarget.Latest,
  );
  const collectInitializers = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectInitializers);
  };
  collectInitializers(sourceFile);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const specifier = node.arguments.at(0);
      if (specifier === undefined || !ts.isStringLiteral(specifier)) {
        computedImports = true;
      }
    }
    const callExpression =
      ts.isCallExpression(node) || ts.isNewExpression(node) ? node : undefined;
    if (callExpression !== undefined) {
      const callee = callExpression.expression.getText(sourceFile);
      if (
        /^(?:readFile(?:Sync)?|readdir(?:Sync)?|glob|Glob|Bun\.file)$/u.test(
          callee,
        ) ||
        /\.(?:readFile(?:Sync)?|readdir(?:Sync)?|glob)$/u.test(callee)
      ) {
        const argument = callExpression.arguments?.at(0);
        fileOperationReaches.push(
          argument === undefined
            ? "all"
            : pathReach(argument, sourceFile, initializers),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  if (LOADER_CALL_PATTERN.test(runnable) || mentionsReads || mentionsScans) {
    visit(sourceFile);
  }
  let reach: ModuleReach = new Set();
  for (const operationReach of fileOperationReaches) {
    reach = mergeReach(reach, operationReach);
  }
  return {
    computedImports,
    imports,
    reads: mentionsReads && READER_PATTERN.test(code),
    reach: fileOperationReaches.length === 0 ? "all" : reach,
    scans: mentionsScans && SCANNER_PATTERN.test(code),
  };
};

export const buildImportGraph = (root: string, starts: readonly string[]) => {
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
      if (reads || scans) {
        reaches.set(file, reach);
      }
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
  return { closure, failed, readers, reaches, scanners, computedImports };
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
            [...closure].some((file) => {
              const reach = graph.reaches.get(file);
              return (
                reach === "all" ||
                (reach !== undefined &&
                  [...changedApps].some((app) => reach.has(app)))
              );
            }))
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
