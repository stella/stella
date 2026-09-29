import { lstatSync, readFileSync, writeFileSync } from "node:fs";
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
  for (const field of [
    "requestCounts",
    "dbQueries",
    "responseSizes",
  ] as const) {
    if (value[field] !== undefined && !isNumberRecord(value[field])) {
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
        const route = node.route.replace(/\/+$/u, "") || "/";
        touched.add(route);
        touched.add(`${route} target`);
        break;
      }
      if (ancestor.parent === "rootRouteImport") {
        if (changed.has("apps/web/src/routes/__root")) {
          const route = node.route.replace(/\/+$/u, "") || "/";
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

export const scopeBaseline = ({
  base,
  recorded,
  changedPaths,
  baseRouteTree,
  routeTree,
  all = false,
}: {
  base: Baseline;
  recorded: Baseline;
  changedPaths: string[];
  baseRouteTree: string;
  routeTree: string;
  all?: boolean;
}): Baseline => {
  if (all) {
    return recorded;
  }
  const changed = new Set(changedPaths.map(normalizeSource));
  const touchedRoutes = new Set([
    ...touchedRoutesInTree(baseRouteTree, changed),
    ...touchedRoutesInTree(routeTree, changed),
  ]);
  const scoped: Baseline = {};
  for (const [route, entry] of Object.entries(recorded)) {
    if (touchedRoutes.has(route)) {
      scoped[route] = entry;
    } else if (base[route] !== undefined) {
      scoped[route] = base[route];
    }
  }
  for (const [route, entry] of Object.entries(base)) {
    if (scoped[route] === undefined && !touchedRoutes.has(route)) {
      scoped[route] = entry;
    }
  }
  return scoped;
};

// Route and request keys come from the recording, so they are rendered as
// inert code spans: no markdown, mentions or line breaks reach the comment.
const code = (value: string): string =>
  `\`${value.replaceAll(/[`\p{Cc}]/gu, " ")}\``;

const NUMBER_FIELDS = ["requestCounts", "dbQueries", "responseSizes"] as const;
// GitHub rejects comment bodies over 65536 characters.
const MAX_SUMMARY_CHARS = 60_000;

const numberChanges = (
  before: BaselineEntry,
  after: BaselineEntry,
): string[] => {
  const changes: string[] = [];
  if (before.depth !== after.depth) {
    changes.push(`depth ${before.depth} → ${after.depth}`);
  }
  for (const field of NUMBER_FIELDS) {
    const previous = before[field] ?? {};
    const next = after[field] ?? {};
    const keys = [
      ...new Set([...Object.keys(previous), ...Object.keys(next)]),
    ].toSorted();
    for (const key of keys) {
      if (previous[key] !== next[key]) {
        changes.push(
          `${field} ${code(key)} ${previous[key] ?? "none"} → ${next[key] ?? "none"}`,
        );
      }
    }
  }
  const previousRequests = new Set(before.requests);
  const nextRequests = new Set(after.requests);
  for (const request of [...nextRequests].toSorted()) {
    if (!previousRequests.has(request)) {
      changes.push(`request ${code(request)} added`);
    }
  }
  for (const request of [...previousRequests].toSorted()) {
    if (!nextRequests.has(request)) {
      changes.push(`request ${code(request)} removed`);
    }
  }
  return changes;
};

/**
 * Markdown for the review thread opened on a recorded baseline commit: every
 * budget change against the base branch, per route, before → after.
 */
export const summarizeBudgetChanges = ({
  base,
  recorded,
}: {
  base: Baseline;
  recorded: Baseline;
}): string => {
  const lines: string[] = [];
  const routes = [
    ...new Set([...Object.keys(base), ...Object.keys(recorded)]),
  ].toSorted();
  for (const route of routes) {
    const before = base[route];
    const after = recorded[route];
    if (before === undefined && after !== undefined) {
      lines.push(
        `- ${code(route)}: added, depth ${after.depth}, allowed requests ${after.requests.length}`,
      );
    } else if (before !== undefined && after === undefined) {
      lines.push(`- ${code(route)}: removed`);
    } else if (before !== undefined && after !== undefined) {
      const changes = numberChanges(before, after);
      if (changes.length > 0) {
        lines.push(`- ${code(route)}: ${changes.join("; ")}`);
      }
    }
  }
  const header = [
    "This network baseline was recorded by this pull request's own code.",
    "",
    lines.length === 0
      ? "No budget changes against the base branch."
      : "Budget changes against the base branch:",
    "",
  ];
  const footer = [
    "",
    "Review these as budget changes and resolve this thread to accept them.",
  ];
  const kept: string[] = [];
  let length = [...header, ...footer].join("\n").length + 100;
  for (const [index, line] of lines.entries()) {
    if (length + line.length + 1 > MAX_SUMMARY_CHARS) {
      kept.push(
        `- ${lines.length - index} more routes changed; see the file diff.`,
      );
      break;
    }
    kept.push(line);
    length += line.length + 1;
  }
  return [...header, ...kept, ...footer].join("\n");
};

const usage = `Usage:
  bun scripts/network-baseline-scope.ts scope --base FILE --recorded FILE --changed FILE --base-route-tree FILE --route-tree FILE [--all]
  bun scripts/network-baseline-scope.ts validate FILE
  bun scripts/network-baseline-scope.ts summary --base FILE --recorded FILE

--changed is a newline-separated list of changed route source paths. scope validates both baselines and limits the recorded file to entries of new or changed routes, restoring every other entry from --base. It limits which entries change; it does not check the recorded values. validate checks the artifact schema and size. summary prints the budget changes as markdown for review.`;

const option = (args: string[], name: string): string => {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) {
    return fail(`missing value for ${name}\n${usage}`);
  }
  return value;
};

const main = (): void => {
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
    validateBaselineFile(file);
    return;
  }
  if (command === "summary") {
    process.stdout.write(
      `${summarizeBudgetChanges({
        base: validateBaselineFile(option(args, "--base")),
        recorded: validateBaselineFile(option(args, "--recorded")),
      })}\n`,
    );
    return;
  }
  if (command !== "scope") {
    fail(`unknown command: ${command}\n${usage}`);
  }
  const recordedPath = option(args, "--recorded");
  const base = validateBaselineFile(option(args, "--base"));
  const recorded = validateBaselineFile(recordedPath);
  const changedPaths = readFileSync(option(args, "--changed"), "utf-8")
    .split(/\r?\n/u)
    .filter(Boolean);
  const routeTree = readFileSync(option(args, "--route-tree"), "utf-8");
  const result = scopeBaseline({
    base,
    recorded,
    changedPaths,
    baseRouteTree: readFileSync(option(args, "--base-route-tree"), "utf-8"),
    routeTree,
    all: args.includes("--all"),
  });
  writeFileSync(recordedPath, `${JSON.stringify(result, null, 2)}\n`);
};

if (import.meta.main) {
  main();
}
