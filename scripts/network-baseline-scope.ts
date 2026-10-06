import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const MAX_BASELINE_BYTES = 5 * 1024 * 1024;

type BaselineEntry = {
  depth: number;
  requests: string[];
  requestCounts?: Record<string, number>;
  dbQueries?: Record<string, number>;
  responseSizes?: Record<string, number>;
};
type Baseline = Record<string, BaselineEntry>;

// The explicit annotation lets TypeScript narrow after `fail(...)` calls.
const fail: (message: string) => never = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNumberRecord = (value: unknown): value is Record<string, number> =>
  isRecord(value) &&
  Object.entries(value).every(
    ([key, number]) =>
      key.length > 0 &&
      typeof number === "number" &&
      Number.isFinite(number) &&
      number >= 0,
  );

const isBaselineEntry = (value: unknown): value is BaselineEntry => {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value["depth"] !== "number" ||
    !Number.isInteger(value["depth"]) ||
    value["depth"] < 0 ||
    !Array.isArray(value["requests"]) ||
    !value["requests"].every(
      (item) => typeof item === "string" && item.length > 0,
    )
  ) {
    return false;
  }
  // A budget belongs to a recorded request; one without it is a leftover
  // allowance that later write passes would keep forever.
  const requests = new Set<unknown>(value["requests"]);
  for (const field of [
    "requestCounts",
    "dbQueries",
    "responseSizes",
  ] as const) {
    const budgets = value[field];
    if (budgets === undefined) {
      continue;
    }
    if (
      !isNumberRecord(budgets) ||
      !Object.keys(budgets).every((key) => requests.has(key))
    ) {
      return false;
    }
  }
  return Object.keys(value).every((field) =>
    [
      "depth",
      "requests",
      "requestCounts",
      "dbQueries",
      "responseSizes",
    ].includes(field),
  );
};

const isBaseline = (value: unknown): value is Baseline =>
  isRecord(value) &&
  Object.entries(value).every(
    ([route, entry]) => route.startsWith("/") && isBaselineEntry(entry),
  );

export const validateBaselineFile = (file: string): Baseline => {
  if (lstatSync(file).isSymbolicLink()) {
    fail(`${file} must not be a symlink`);
  }
  const contents = readFileSync(file, "utf-8");
  if (Buffer.byteLength(contents) > MAX_BASELINE_BYTES) {
    fail(`${file} exceeds ${MAX_BASELINE_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    fail(`${file} is not valid JSON`);
  }
  if (!isBaseline(parsed)) {
    fail(`${file} does not match the network baseline schema`);
  }
  return parsed;
};

const routeSource = (specifier: string): string =>
  path.posix.normalize(`apps/web/src/${specifier.replace(/^\.\//u, "")}`);

// The lookbehind keeps a long run of slashes linear to strip.
const withoutTrailingSlash = (route: string) =>
  route.replace(/(?<!\/)\/+$/u, "") || "/";

const normalizeSource = (source: string): string => {
  const repoPath = source.replaceAll("\\", "/").replace(/^\.?\//u, "");
  return repoPath.replace(/\.(tsx?|jsx?)$/u, "");
};

const touchedRoutesInTree = (
  routeTree: string,
  changed: Set<string>,
): Set<string> => {
  const imports = new Map<string, string>();
  for (const match of routeTree.matchAll(
    /import\s*\{\s*Route\s+as\s+(\w+)\s*\}\s*from\s*['"](\.\/routes\/[^'"]+)['"]/gu,
  )) {
    const [, alias, specifier] = match;
    if (alias && specifier) {
      imports.set(alias, routeSource(specifier));
    }
  }
  const interfaceStart = routeTree.indexOf("interface FileRoutesByPath {");
  const interfaceEnd = routeTree.indexOf("\n  }\n}", interfaceStart);
  if (interfaceStart === -1 || interfaceEnd === -1) {
    fail("route tree has no FileRoutesByPath interface");
  }
  const nodes = new Map<string, { route: string; parent: string }>();
  const declarations = routeTree.slice(interfaceStart, interfaceEnd);
  for (const [, body] of declarations.matchAll(
    /^ {4}'[^']+': \{([\s\S]*?)^ {4}\}/gmu,
  )) {
    const route = body?.match(/fullPath: '([^']+)'/u)?.[1];
    const alias = body?.match(/preLoaderRoute: typeof (\w+)/u)?.[1];
    const parent = body?.match(/parentRoute: typeof (\w+)/u)?.[1];
    if (!route || !alias || !parent || !imports.has(alias)) {
      fail("route tree has an incomplete FileRoutesByPath entry");
    }
    nodes.set(alias, { route, parent });
  }
  if (nodes.size === 0) {
    fail("route tree has no FileRoutesByPath entries");
  }

  const touched = new Set<string>();
  for (const [alias, node] of nodes) {
    let ancestorAlias = alias;
    const seen = new Set<string>();
    while (true) {
      const ancestor = nodes.get(ancestorAlias);
      if (!ancestor) {
        fail(`route tree has an unknown parent: ${ancestorAlias}`);
      }
      // Parent route variables correspond to the generated import alias plus "Import".
      const source = imports.get(ancestorAlias);
      if (source && changed.has(normalizeSource(source))) {
        const route = withoutTrailingSlash(node.route);
        touched.add(route);
        touched.add(`${route} target`);
        break;
      }
      if (ancestor.parent === "rootRouteImport") {
        if (changed.has("apps/web/src/routes/__root")) {
          const route = withoutTrailingSlash(node.route);
          touched.add(route);
          touched.add(`${route} target`);
        }
        break;
      }
      ancestorAlias = `${ancestor.parent}Import`;
      if (seen.has(ancestorAlias)) {
        fail("route tree has a parent cycle");
      }
      seen.add(ancestorAlias);
    }
  }
  return touched;
};

const applyNetworkBudgetDeclarations = (
  base: Baseline,
  declarations: unknown[],
) => {
  const baseline = { ...base };
  const declared = new Set<string>();
  const notices: string[] = [];
  for (const declaration of declarations) {
    if (
      !isRecord(declaration) ||
      typeof declaration["route"] !== "string" ||
      !declaration["route"].startsWith("/") ||
      typeof declaration["reason"] !== "string" ||
      declaration["reason"].trim().length === 0 ||
      !isBaselineEntry(declaration["budget"]) ||
      Object.keys(declaration).some(
        (key) => !["route", "reason", "budget"].includes(key),
      )
    ) {
      fail(
        "Invalid network budget declaration: expected route, nonempty reason and budget",
      );
    }
    const route = declaration["route"];
    if (declared.has(route)) {
      fail(`Duplicate network budget declaration for ${route}`);
    }
    declared.add(route);
    baseline[route] = declaration["budget"];
    notices.push(`- ${code(route)}: ${code(declaration["reason"])}`);
  }
  return { baseline, notices };
};

export const prepareComparisonBaseline = ({
  base,
  changedPaths,
  baseRouteTree,
  routeTree,
  declarations,
}: {
  base: Baseline;
  changedPaths: string[];
  baseRouteTree: string;
  routeTree: string;
  declarations: unknown[];
}) => {
  const changed = new Set(changedPaths.map(normalizeSource));
  const changedRoutes = [
    ...new Set([
      ...touchedRoutesInTree(baseRouteTree, changed),
      ...touchedRoutesInTree(routeTree, changed),
    ]),
  ].toSorted();
  return {
    ...applyNetworkBudgetDeclarations(base, declarations),
    changedRoutes,
  };
};

export const networkBudgetDeclarationProblem = ({
  expectedKeys,
  declarations,
}: {
  expectedKeys: string[];
  declarations: unknown[];
}): string | null => {
  // Validate without reapplying inherited allowances to a prepared recording.
  applyNetworkBudgetDeclarations({}, declarations);
  for (const declaration of declarations) {
    if (
      isRecord(declaration) &&
      !expectedKeys.includes(String(declaration["route"]))
    ) {
      return `Network budget declaration names an inactive route: ${String(declaration["route"])}`;
    }
  }
  return null;
};

// Render declaration text as inert code spans in the job summary.
const code = (value: string): string =>
  `\`${value.replaceAll(/[`\p{Cc}]/gu, " ")}\``;

const usage = `Usage:
  bun scripts/network-baseline-scope.ts prepare --base FILE --changed FILE --base-route-tree FILE --route-tree FILE --output FILE --context FILE
  bun scripts/network-baseline-scope.ts validate FILE [--route-tree FILE --context FILE]

prepare loads a merge-base budget, scopes new/removed routes, and applies only changed, reviewed declaration files. validate checks a main recording's schema and size.`;

const option = (args: string[], name: string): string => {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) {
    return fail(`missing value for ${name}\n${usage}`);
  }
  return value;
};

const main = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "-h" || command === undefined) {
    console.log(usage);
    return;
  }
  if (command === "validate") {
    const file = args.find((arg) => !arg.startsWith("-"));
    if (!file) {
      fail(usage);
    }
    const baseline = validateBaselineFile(file);
    if (args.includes("--route-tree")) {
      const directory = "apps/web/e2e/network-budgets";
      const declarations = (existsSync(directory) ? readdirSync(directory) : [])
        .filter((name) => name.endsWith(".json"))
        .map((name): unknown => {
          const declarationFile = path.join(directory, name);
          if (
            lstatSync(declarationFile).isSymbolicLink() ||
            lstatSync(declarationFile).size > MAX_BASELINE_BYTES
          ) {
            fail(`Invalid network budget declaration file: ${declarationFile}`);
          }
          return JSON.parse(readFileSync(declarationFile, "utf-8"));
        });
      const {
        assertSmokeRouteCoverage,
        networkBaselineKey,
        networkBaselineCoverageProblem,
      } = await import("../apps/web/e2e/helpers/smoke-route-coverage");
      const { SMOKE_ROUTE_DEFS } =
        await import("../apps/web/e2e/helpers/smoke-route-defs");
      assertSmokeRouteCoverage(
        readFileSync(option(args, "--route-tree"), "utf-8"),
      );
      const context: unknown = JSON.parse(
        readFileSync(option(args, "--context"), "utf-8"),
      );
      if (
        !Array.isArray(context) ||
        !context.every(
          (route) => typeof route === "string" && route.startsWith("/"),
        )
      ) {
        fail("Invalid network baseline changed-route context");
      }
      const expectedKeys = SMOKE_ROUTE_DEFS.map(networkBaselineKey);
      const problem =
        networkBudgetDeclarationProblem({ expectedKeys, declarations }) ??
        networkBaselineCoverageProblem({
          actualKeys: Object.keys(baseline),
          expectedKeys,
          changedRoutes: context,
        });
      if (problem !== null) {
        fail(problem);
      }
    }
    return;
  }
  if (command === "prepare") {
    const changedPaths = readFileSync(option(args, "--changed"), "utf-8")
      .split(/\r?\n/u)
      .filter(Boolean);
    if (changedPaths.includes("apps/web/e2e/network-baseline.json")) {
      fail(
        "PRs must declare network budget changes instead of editing network-baseline.json",
      );
    }
    const declarations = changedPaths
      .filter((file) =>
        /^apps\/web\/e2e\/network-budgets\/[^/]+\.json$/u.test(file),
      )
      .filter((file) =>
        // A deleted declaration does not grant a budget.
        existsSync(file),
      )
      .map((file): unknown => {
        if (
          lstatSync(file).isSymbolicLink() ||
          lstatSync(file).size > MAX_BASELINE_BYTES
        ) {
          fail(`Invalid network budget declaration file: ${file}`);
        }
        return JSON.parse(readFileSync(file, "utf-8"));
      });
    const { baseline, changedRoutes, notices } = prepareComparisonBaseline({
      base: validateBaselineFile(option(args, "--base")),
      changedPaths,
      baseRouteTree: readFileSync(option(args, "--base-route-tree"), "utf-8"),
      routeTree: readFileSync(option(args, "--route-tree"), "utf-8"),
      declarations,
    });
    writeFileSync(
      option(args, "--output"),
      `${JSON.stringify(baseline, null, 2)}\n`,
    );
    writeFileSync(
      option(args, "--context"),
      `${JSON.stringify(changedRoutes)}\n`,
    );
    process.stdout.write(
      `### Declared network budget changes\n${notices.join("\n") || "None."}\n`,
    );
    return;
  }
  fail(`unknown command: ${command}\n${usage}`);
};

if (import.meta.main) {
  await main();
}
