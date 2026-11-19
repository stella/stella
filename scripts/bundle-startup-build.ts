// Reads a StartupGraph (bundle-startup-gates.ts) from a production web build.
//
// Inputs, all produced by `bun --filter @stll/web build`:
//   - dist/server/assets/_tanstack-start-manifest_v-*.js: the Start manifest
//     the server renders `<link rel="modulepreload">` tags from. `__root__`
//     preloads are the initial graph; each route's preloads are what the
//     document links for it.
//   - dist/client/assets/*.js and their hidden `.js.map` files: chunk bytes,
//     the modules in each chunk, which module issues each `import()`, and,
//     from each app module's original source, the app modules it imports.
//
// Module ids are app-relative (`src/routes/law/coverage.tsx`), the query the
// route code splitter adds kept (`?tsr-split=component`, `?tsr-shared=1`).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { ROUTE_TREE_OPTIONS } from "../apps/web/route-tree.config";
import {
  type ArrayExpression,
  type Node,
  type ObjectExpression,
  parseSource,
  type Program,
  type Statement,
  staticPropertyName,
  type UnaryExpression,
  walk,
} from "../packages/scripts/src/syntax-tree";
import type {
  BuiltChunk,
  StartupGraph,
  StartupRoute,
} from "./bundle-startup-gates";
import { attributeChunk } from "./bundle-startup-sourcemap";

const CLIENT_ASSETS = "client/assets";
const MANIFEST_GLOB = "server/assets/_tanstack-start-manifest_v-*.js";
const ROOT_ROUTE_ID = "__root__";
const ROUTES_PREFIX = `${ROUTE_TREE_OPTIONS.srcDirectory}/${ROUTE_TREE_OPTIONS.routesDirectory}/`;
const ROOT_ROUTE_FILE = `${ROUTES_PREFIX}__root.tsx`;

const ManifestSchema = v.object({
  routes: v.record(
    v.string(),
    v.object({
      filePath: v.optional(v.string()),
      preloads: v.optional(v.array(v.string())),
    }),
  ),
});
type Manifest = v.InferOutput<typeof ManifestSchema>;

const SourceMapSchema = v.object({
  sources: v.array(v.string()),
  sourcesContent: v.optional(v.array(v.nullable(v.string()))),
  mappings: v.string(),
});

export type ReadResult =
  { ok: true; graph: StartupGraph } | { ok: false; error: string };

/** `/assets/index-abc.js` -> `index-abc.js` */
const chunkFileName = (url: string): string => path.posix.basename(url);

type Literal = { ok: true; value: unknown } | { ok: false; node: string };

/**
 * The value of a JSON-like expression as a minifier prints it (`!0`,
 * `void 0`, parentheses included). Anything else is refused by node type:
 * the manifest is read as data, never run.
 */
const unaryValue = (node: UnaryExpression): Literal => {
  // `void x` discards x, but a computed x is still code: check it first.
  const argument = literalValue(node.argument);
  if (!argument.ok) {
    return argument;
  }
  if (node.operator === "void") {
    return { ok: true, value: undefined };
  }
  if (node.operator === "!") {
    return { ok: true, value: !argument.value };
  }
  if (node.operator === "-" && typeof argument.value === "number") {
    return { ok: true, value: -argument.value };
  }
  return { ok: false, node: `UnaryExpression ${node.operator}` };
};

const arrayValue = (node: ArrayExpression): Literal => {
  const values: unknown[] = [];
  for (const element of node.elements) {
    if (element === null || element.type === "SpreadElement") {
      return { ok: false, node: element?.type ?? "array hole" };
    }
    const value = literalValue(element);
    if (!value.ok) {
      return value;
    }
    values.push(value.value);
  }
  return { ok: true, value: values };
};

const objectValue = (node: ObjectExpression): Literal => {
  const entries: [string, unknown][] = [];
  for (const property of node.properties) {
    const key =
      property.type === "Property" ? staticPropertyName(property) : undefined;
    if (property.type !== "Property" || key === undefined) {
      return { ok: false, node: property.type };
    }
    const value = literalValue(property.value);
    if (!value.ok) {
      return value;
    }
    entries.push([key, value.value]);
  }
  return { ok: true, value: Object.fromEntries(entries) };
};

export const literalValue = (node: Node): Literal => {
  if (node.type === "ParenthesizedExpression") {
    return literalValue(node.expression);
  }
  if (node.type === "Literal") {
    return { ok: true, value: node.value };
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return { ok: true, value: node.quasis.at(0)?.value.cooked ?? "" };
  }
  if (node.type === "Identifier") {
    return node.name === "undefined"
      ? { ok: true, value: undefined }
      : { ok: false, node: `Identifier ${node.name}` };
  }
  if (node.type === "UnaryExpression") {
    return unaryValue(node);
  }
  if (node.type === "ArrayExpression") {
    return arrayValue(node);
  }
  if (node.type === "ObjectExpression") {
    return objectValue(node);
  }
  return { ok: false, node: node.type };
};

/** The object `tsrStartManifest = () => ({ ... })` returns, read as data. */
export const parseStartManifest = (
  fileName: string,
  source: string,
): Manifest | string => {
  let body: Node | undefined;
  walk(parseSource(fileName, source).program, (node) => {
    if (
      body === undefined &&
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name === "tsrStartManifest" &&
      node.init?.type === "ArrowFunctionExpression" &&
      node.init.expression
    ) {
      body = node.init.body;
    }
    return body === undefined ? undefined : "skip-children";
  });
  if (body === undefined) {
    return `${fileName} does not declare tsrStartManifest as an arrow returning an object`;
  }
  const literal = literalValue(body);
  if (!literal.ok) {
    return `${fileName}: the manifest is not plain data (${literal.node})`;
  }
  const manifest = v.safeParse(ManifestSchema, literal.value);
  if (!manifest.success) {
    return `${fileName} is not a Start manifest: ${v.summarize(manifest.issues)}`;
  }
  return manifest.output;
};

const readManifest = (distDir: string): Manifest | string => {
  const files = [...new Bun.Glob(MANIFEST_GLOB).scanSync(distDir)];
  const [file] = files;
  if (file === undefined || files.length !== 1) {
    return `Expected one Start manifest at ${MANIFEST_GLOB} in ${distDir}, found ${files.length}. Build the web app first.`;
  }
  return parseStartManifest(
    file,
    readFileSync(path.join(distDir, file), "utf-8"),
  );
};

// `import(`./x.js`)`: Rolldown's dynamic import of a sibling chunk.
const DYNAMIC_IMPORT = /\bimport\(\s*[`'"]\.\/([^`'"]+?\.js)[`'"]\s*\)/gu;
// `import"./x.js"` and `from"./x.js"`: a static import or re-export.
const STATIC_IMPORT = /(?:\bimport|\bfrom)\s*[`'"]\.\/([^`'"]+?\.js)[`'"]/gu;

const lineStarts = (code: string): number[] => {
  const starts = [0];
  for (
    let index = code.indexOf("\n");
    index >= 0;
    index = code.indexOf("\n", index + 1)
  ) {
    starts.push(index + 1);
  }
  return starts;
};

const positionOf = (
  starts: readonly number[],
  offset: number,
): { line: number; column: number } => {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { line: low, column: offset - (starts[low] ?? 0) };
};

/** A map source (relative to dist/client/assets) made app-relative. */
const appRelative = (source: string): string =>
  path.posix.normalize(path.posix.join("dist", CLIENT_ASSETS, source));

/** An inclusive range of 0-based original lines. */
export type LineRange = readonly [start: number, end: number];

/**
 * One top-level binding a component can reach: a function or class
 * declaration, or a single declarator of a `const`/`let` statement, so two
 * declarators sharing a statement are measured apart.
 */
type DeclarationUnit = {
  names: readonly string[];
  node: Node;
};

const declarationUnits = (statement: Statement): DeclarationUnit[] => {
  const declaration =
    statement.type === "ExportNamedDeclaration" ||
    statement.type === "ExportDefaultDeclaration"
      ? statement.declaration
      : statement;
  if (declaration === null) {
    return [];
  }
  if (
    (declaration.type === "FunctionDeclaration" ||
      declaration.type === "ClassDeclaration") &&
    declaration.id !== null
  ) {
    return [{ names: [declaration.id.name], node: statement }];
  }
  if (declaration.type === "VariableDeclaration") {
    const single = declaration.declarations.length === 1;
    return declaration.declarations.flatMap((declarator) =>
      declarator.id.type === "Identifier"
        ? [
            {
              names: [declarator.id.name],
              // A lone declarator keeps its statement's span (`export const`).
              node: single ? statement : declarator,
            },
          ]
        : [],
    );
  }
  return [];
};

/**
 * Whether an identifier names something rather than reading a binding: an
 * object key, a member name, a JSX attribute or member name, a class member
 * key. `{ Page: true }` and `props.Page` never reach a local `Page`.
 */
const isNameNotReference = (node: Node, parent: Node | undefined): boolean => {
  if (parent === undefined) {
    return false;
  }
  if (parent.type === "Property") {
    return parent.key === node && !parent.computed && !parent.shorthand;
  }
  if (parent.type === "MemberExpression") {
    return parent.property === node && !parent.computed;
  }
  if (parent.type === "JSXAttribute") {
    return parent.name === node;
  }
  if (parent.type === "JSXMemberExpression") {
    return parent.property === node;
  }
  if (
    parent.type === "MethodDefinition" ||
    parent.type === "PropertyDefinition"
  ) {
    return parent.key === node && !parent.computed;
  }
  return false;
};

const referencedNames = (node: Node): Set<string> => {
  const names = new Set<string>();
  walk(node, (child, ancestors) => {
    if (
      (child.type === "Identifier" || child.type === "JSXIdentifier") &&
      !isNameNotReference(child, ancestors.at(-1))
    ) {
      names.add(child.name);
    }
  });
  return names;
};

// Route options that render UI. Every other option (loader, beforeLoad,
// head, validateSearch, ...) is route data, which belongs in the initial
// graph.
const VIEW_OPTIONS = new Set([
  "component",
  "pendingComponent",
  "errorComponent",
  "notFoundComponent",
]);

type RouteOptions = {
  statement: Statement;
  component: Node | undefined;
  data: Node[];
};

const findRouteOptions = (program: Program): RouteOptions | undefined => {
  let found: RouteOptions | undefined;
  walk(program, (node, ancestors) => {
    if (found !== undefined) {
      return "skip-children";
    }
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "CallExpression" ||
      node.callee.callee.type !== "Identifier" ||
      node.callee.callee.name !== "createFileRoute"
    ) {
      return undefined;
    }
    // ancestors[0] is the program, ancestors[1] the top-level statement.
    const statement = program.body.find((entry) => entry === ancestors[1]);
    if (statement === undefined) {
      return "skip-children";
    }
    const options = node.arguments[0];
    const route: RouteOptions = { statement, component: undefined, data: [] };
    for (const property of options?.type === "ObjectExpression"
      ? options.properties
      : []) {
      if (property.type !== "Property") {
        route.data.push(property);
        continue;
      }
      const name = staticPropertyName(property);
      if (name === "component") {
        route.component = property.value;
      } else if (name === undefined || !VIEW_OPTIONS.has(name)) {
        route.data.push(property);
      }
    }
    found = route;
    return "skip-children";
  });
  return found;
};

/**
 * The lines of a route file's top-level declarations that only its route's
 * `component` needs: everything the component reaches through the file's own
 * declarations, less what the route's data options (loader, beforeLoad, head,
 * validateSearch, ...) reach too. The code splitter moves that code into the
 * lazy component chunk unless an eager view (a pending or error component)
 * or an export holds on to it; whatever of it the initial chunks still map
 * to is page code paid at startup. Empty for a file without a route
 * component.
 */
export const componentDeclarationLines = (
  fileName: string,
  source: string,
): LineRange[] => {
  if (!source.includes("createFileRoute")) {
    return [];
  }
  const parsed = parseSource(fileName, source);
  const route = findRouteOptions(parsed.program);
  if (route?.component === undefined) {
    return [];
  }
  const declarations = parsed.program.body
    .filter((statement) => statement !== route.statement)
    .flatMap(declarationUnits)
    .map((unit) => ({ ...unit, references: referencedNames(unit.node) }));
  const reach = (roots: readonly Node[]): Set<Node> => {
    const reached = new Set<Node>();
    const pending = roots.flatMap((root) => [...referencedNames(root)]);
    const visited = new Set<string>();
    for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
      if (visited.has(name)) {
        continue;
      }
      visited.add(name);
      for (const declaration of declarations) {
        if (declaration.names.includes(name)) {
          reached.add(declaration.node);
          pending.push(...declaration.references);
        }
      }
    }
    return reached;
  };
  const data = reach(route.data);
  return [...reach([route.component])]
    .filter((node) => !data.has(node))
    .map((node) => [
      parsed.locate(node.start).line - 1,
      parsed.locate(node.end).line - 1,
    ]);
};

const bytesInRanges = (
  perLine: ReadonlyMap<number, number> | undefined,
  ranges: readonly LineRange[],
): number => {
  let bytes = 0;
  for (const [line, lineBytes] of perLine ?? []) {
    if (ranges.some(([start, end]) => line >= start && line <= end)) {
      bytes += lineBytes;
    }
  }
  return bytes;
};

type ReadChunk = {
  chunk: BuiltChunk;
  /** Route file to the initial bytes of its component's declarations. */
  routeComponentBytes: Map<string, number>;
  /** App module id to the specifiers it imports statically. */
  moduleSpecifiers: Map<string, string[]>;
  /** No map and not a re-export facade: its modules cannot be known. */
  opaque: boolean;
};

const APP_SOURCE_PREFIX = `${ROUTE_TREE_OPTIONS.srcDirectory}/`;

/**
 * The specifiers a module imports or re-exports statically, type-only ones
 * left out: those are erased and load nothing.
 */
export const staticSpecifiers = (
  fileName: string,
  source: string,
): string[] => {
  const { module } = parseSource(fileName, source);
  return [
    ...module.staticImports
      .filter(
        ({ entries }) =>
          entries.length === 0 || entries.some(({ isType }) => !isType),
      )
      .map(({ moduleRequest }) => moduleRequest.value),
    ...module.staticExports.flatMap(({ entries }) =>
      entries.flatMap(({ moduleRequest, isType }) =>
        moduleRequest === null || isType ? [] : [moduleRequest.value],
      ),
    ),
  ];
};

const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  "/index.ts",
  "/index.tsx",
] as const;

/**
 * The app module an app-relative or `@/` specifier names, among the module
 * paths the build holds. Undefined for a package or anything outside them.
 */
export const resolveAppImport = (
  importer: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | undefined => {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = `${APP_SOURCE_PREFIX}${specifier.slice(2)}`;
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = path.posix.normalize(
      path.posix.join(path.posix.dirname(importer), specifier),
    );
  } else {
    return undefined;
  }
  return RESOLVE_SUFFIXES.map((suffix) => `${base}${suffix}`).find((file) =>
    known.has(file),
  );
};

const withoutQuery = (id: string): string => {
  const query = id.indexOf("?");
  return query === -1 ? id : id.slice(0, query);
};

/** Each app module's static specifiers, read from its original source. */
const appModuleSpecifiers = (
  ids: readonly string[],
  contents: readonly (string | null)[] | undefined,
): Map<string, string[]> => {
  const specifiers = new Map<string, string[]>();
  for (const [index, id] of ids.entries()) {
    const content = contents?.[index];
    if (typeof content === "string" && id.startsWith(APP_SOURCE_PREFIX)) {
      specifiers.set(id, staticSpecifiers(withoutQuery(id), content));
    }
  }
  return specifiers;
};

/** Resolves each module's specifiers to the build's module ids. */
export const resolveModuleImports = (
  specifiers: ReadonlyMap<string, readonly string[]>,
  moduleIds: Iterable<string>,
): Map<string, string[]> => {
  const idsByPath = new Map<string, string[]>();
  for (const id of moduleIds) {
    const file = withoutQuery(id);
    const ids = idsByPath.get(file) ?? [];
    if (!ids.includes(id)) {
      ids.push(id);
    }
    idsByPath.set(file, ids);
  }
  const known = new Set(idsByPath.keys());
  const imports = new Map<string, string[]>();
  for (const [importer, list] of specifiers) {
    const resolved = new Set<string>();
    for (const specifier of list) {
      const file = resolveAppImport(withoutQuery(importer), specifier, known);
      // A plain import names the module itself, not a split or shared part.
      const ids = file === undefined ? [] : (idsByPath.get(file) ?? []);
      for (const id of ids.includes(file ?? "") ? [file ?? ""] : ids) {
        resolved.add(id);
      }
    }
    imports.set(importer, [...resolved]);
  }
  return imports;
};

// The module runtime Rolldown emits beside the entry carries no source.
const MODULE_RUNTIME = /^rolldown-runtime-[\w-]+\.js$/u;

/** A chunk of nothing but static imports and re-exports of other chunks. */
export const isReexportFacade = (fileName: string, code: string): boolean =>
  parseSource(fileName, code).program.body.every(
    (statement) =>
      statement.type === "ImportDeclaration" ||
      statement.type === "ExportAllDeclaration" ||
      (statement.type === "ExportNamedDeclaration" &&
        statement.declaration === null),
  );

const parseSourceMap = (
  mapFile: string,
): v.InferOutput<typeof SourceMapSchema> | string => {
  let json: unknown;
  // A truncated or hand-edited map is a broken build, reported by name.
  try {
    json = JSON.parse(readFileSync(mapFile, "utf-8"));
  } catch (error) {
    return `${path.basename(mapFile)} is not valid JSON (${String(error)}); rebuild the web app.`;
  }
  const map = v.safeParse(SourceMapSchema, json);
  return map.success
    ? map.output
    : `${path.basename(mapFile)} is not a sourcemap: ${v.summarize(map.issues)}`;
};

const readChunk = (
  assetsDir: string,
  fileName: string,
  initial: boolean,
): ReadChunk | string => {
  const file = path.join(assetsDir, fileName);
  const mapFile = `${file}.map`;
  const raw = readFileSync(file);
  const code = raw.toString("utf-8");
  const staticImports = [...code.matchAll(STATIC_IMPORT)].map(
    (match) => match[1] ?? "",
  );
  if (!existsSync(mapFile)) {
    // Rolldown writes no map for a chunk without original code: the module
    // runtime and a re-export facade. Their bytes still count; they have no
    // modules. Any other chunk without a map hides what it carries, which
    // the initial graph cannot afford.
    const opaque =
      !MODULE_RUNTIME.test(fileName) && !isReexportFacade(fileName, code);
    if (initial && opaque) {
      return `${fileName} is an initial chunk without a sourcemap; rebuild the web app with hidden sourcemaps.`;
    }
    return {
      chunk: {
        fileName,
        gzipBytes: Bun.gzipSync(raw).length,
        codeBytes: raw.length,
        modules: new Map(),
        staticImports,
        dynamicImports: [],
      },
      routeComponentBytes: new Map(),
      moduleSpecifiers: new Map(),
      opaque,
    };
  }
  const map = parseSourceMap(mapFile);
  if (typeof map === "string") {
    return map;
  }
  const ids = map.sources.map(appRelative);
  // An initial route file's component declarations, by source index.
  const componentLines = new Map<number, LineRange[]>();
  if (initial) {
    for (const [index, id] of ids.entries()) {
      if (!id.startsWith(ROUTES_PREFIX) || id.includes("?")) {
        continue;
      }
      const content = map.sourcesContent?.[index];
      if (typeof content !== "string") {
        return `${fileName}.map has no source text for ${id}, so its route component cannot be measured; rebuild the web app.`;
      }
      const ranges = componentDeclarationLines(id, content);
      if (ranges.length > 0) {
        componentLines.set(index, ranges);
      }
    }
  }
  // Only the initial chunks need sizes per module, and only a chunk that
  // issues `import()` needs positions; the rest skip decoding the mappings.
  const hasDynamicImport = code.includes("import(");
  const attribution =
    initial || hasDynamicImport
      ? attributeChunk(code, map, new Set(componentLines.keys()))
      : undefined;
  const modules = new Map<string, number>();
  for (const [index, id] of ids.entries()) {
    modules.set(
      id,
      (modules.get(id) ?? 0) + (attribution?.bytesBySource[index] ?? 0),
    );
  }
  const routeComponentBytes = new Map<string, number>();
  for (const [index, ranges] of componentLines) {
    const id = ids[index];
    const bytes = bytesInRanges(attribution?.bytesByLine.get(index), ranges);
    if (id !== undefined && bytes > 0) {
      routeComponentBytes.set(id, (routeComponentBytes.get(id) ?? 0) + bytes);
    }
  }
  const moduleSpecifiers = appModuleSpecifiers(ids, map.sourcesContent);
  const dynamicImports: BuiltChunk["dynamicImports"][number][] = [];
  if (attribution !== undefined && hasDynamicImport) {
    const starts = lineStarts(code);
    for (const match of code.matchAll(DYNAMIC_IMPORT)) {
      const { line, column } = positionOf(starts, match.index);
      const source = attribution.sourceAt(line, column);
      dynamicImports.push({
        target: match[1] ?? "",
        importer: source < 0 ? undefined : ids[source],
      });
    }
  }
  return {
    chunk: {
      fileName,
      gzipBytes: Bun.gzipSync(raw).length,
      codeBytes: raw.length,
      modules,
      staticImports,
      dynamicImports,
    },
    routeComponentBytes,
    moduleSpecifiers,
    opaque: false,
  };
};

/** Whether route id `ancestor` encloses `id` (`/law` encloses `/law/cases/`). */
const encloses = (ancestor: string, id: string): boolean =>
  ancestor === ROOT_ROUTE_ID ||
  (ancestor !== id && id.startsWith(`${ancestor}/`));

/**
 * Each route's preloads including its ancestors': the manifest lists a
 * chunk once, at the highest route that needs it, and the document links
 * every matched route's preloads, the root's included. Route ids nest by
 * path segment, and the manifest omits a route without assets (with its
 * `children`), so ancestry comes from the ids.
 */
const effectivePreloads = (manifest: Manifest): Map<string, string[]> => {
  const entries = Object.entries(manifest.routes);
  const preloads = new Map<string, string[]>();
  for (const [id] of entries) {
    const chain = entries
      .filter(([other]) => other === id || encloses(other, id))
      .flatMap(([, route]) => route.preloads ?? []);
    preloads.set(id, [...new Set(chain.map(chunkFileName))]);
  }
  return preloads;
};

const readRoutes = (
  manifest: Manifest,
  appRoot: string,
): StartupRoute[] | string => {
  const preloads = effectivePreloads(manifest);
  const routes: StartupRoute[] = [];
  for (const [id, route] of Object.entries(manifest.routes)) {
    if (id === ROOT_ROUTE_ID || route.filePath === undefined) {
      continue;
    }
    if (!route.filePath.startsWith(appRoot)) {
      return `Route ${id} lives outside the app: ${route.filePath}`;
    }
    routes.push({
      id,
      filePath: route.filePath.slice(appRoot.length),
      preloads: preloads.get(id) ?? [],
    });
  }
  return routes;
};

export const readStartupGraph = (distDir: string): ReadResult => {
  const manifest = readManifest(distDir);
  if (typeof manifest === "string") {
    return { ok: false, error: manifest };
  }
  const root = manifest.routes[ROOT_ROUTE_ID];
  const rootFile = root?.filePath;
  if (
    root === undefined ||
    rootFile === undefined ||
    !rootFile.endsWith(`/${ROOT_ROUTE_FILE}`)
  ) {
    return {
      ok: false,
      error: `The Start manifest's ${ROOT_ROUTE_ID} route does not point at ${ROOT_ROUTE_FILE}.`,
    };
  }
  // The build machine's absolute app directory, with its trailing slash.
  const appRoot = rootFile.slice(0, -ROOT_ROUTE_FILE.length);
  const routes = readRoutes(manifest, appRoot);
  if (typeof routes === "string") {
    return { ok: false, error: routes };
  }
  const initialChunks = (root.preloads ?? []).map(chunkFileName);
  if (initialChunks.length === 0) {
    return {
      ok: false,
      error: `The Start manifest's ${ROOT_ROUTE_ID} route preloads nothing; the build is incomplete.`,
    };
  }
  const initial = new Set(initialChunks);

  const assetsDir = path.join(distDir, CLIENT_ASSETS);
  const chunks = new Map<string, BuiltChunk>();
  const opaque = new Set<string>();
  const routeComponentBytes = new Map<string, number>();
  const moduleSpecifiers = new Map<string, string[]>();
  for (const fileName of new Bun.Glob("*.js").scanSync(assetsDir)) {
    const read = readChunk(assetsDir, fileName, initial.has(fileName));
    if (typeof read === "string") {
      return { ok: false, error: read };
    }
    chunks.set(fileName, read.chunk);
    if (read.opaque) {
      opaque.add(fileName);
    }
    for (const [id, bytes] of read.routeComponentBytes) {
      routeComponentBytes.set(id, (routeComponentBytes.get(id) ?? 0) + bytes);
    }
    for (const [id, specifiers] of read.moduleSpecifiers) {
      moduleSpecifiers.set(id, specifiers);
    }
  }
  const missing = initialChunks.filter((file) => !chunks.has(file));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Initial chunk(s) missing from ${assetsDir}: ${missing.join(", ")}`,
    };
  }
  // A route file's import() target must show what it loads, or a late page
  // in it would pass the cold-load hop gate unseen.
  for (const chunk of chunks.values()) {
    for (const { target, importer } of chunk.dynamicImports) {
      if (importer?.startsWith(ROUTES_PREFIX) === true && opaque.has(target)) {
        return {
          ok: false,
          error: `${importer} loads ${target}, which has no sourcemap; rebuild the web app with hidden sourcemaps.`,
        };
      }
    }
  }
  return {
    ok: true,
    graph: {
      initialChunks,
      chunks,
      routes,
      routeComponentBytes,
      moduleImports: resolveModuleImports(
        moduleSpecifiers,
        [...chunks.values()].flatMap((chunk) => [...chunk.modules.keys()]),
      ),
    },
  };
};
