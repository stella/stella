// Reads a StartupGraph (bundle-startup-gates.ts) from a production web build.
//
// Inputs, all produced by `bun --filter @stll/web build`:
//   - dist/server/assets/_tanstack-start-manifest_v-*.js: the Start manifest
//     the server renders `<link rel="modulepreload">` tags from. `__root__`
//     preloads are the initial graph; each route's preloads are what the
//     document links for it.
//   - dist/client/assets/*.js and their hidden `.js.map` files: chunk bytes,
//     the modules in each chunk, and which module issues each `import()`.
//
// Module ids are app-relative (`src/routes/law/coverage.tsx`), the query the
// route code splitter adds kept (`?tsr-split=component`, `?tsr-shared=1`).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as v from "valibot";

import { ROUTE_TREE_OPTIONS } from "../apps/web/route-tree.config";
import {
  type Node,
  parseSource,
  type Program,
  type Statement,
  staticPropertyName,
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

const readManifest = async (distDir: string): Promise<Manifest | string> => {
  const files = [...new Bun.Glob(MANIFEST_GLOB).scanSync(distDir)];
  const [file] = files;
  if (file === undefined || files.length !== 1) {
    return `Expected one Start manifest at ${MANIFEST_GLOB} in ${distDir}, found ${files.length}. Build the web app first.`;
  }
  // The manifest is a side-effect-free module of one object literal.
  const imported = v.safeParse(
    v.object({ tsrStartManifest: v.function() }),
    await import(pathToFileURL(path.join(distDir, file)).href),
  );
  if (!imported.success) {
    return `${file} does not export tsrStartManifest`;
  }
  const manifest = v.safeParse(
    ManifestSchema,
    imported.output.tsrStartManifest(),
  );
  if (!manifest.success) {
    return `${file} is not a Start manifest: ${v.summarize(manifest.issues)}`;
  }
  return manifest.output;
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

const declaredNames = (statement: Statement): string[] => {
  const declaration =
    statement.type === "ExportNamedDeclaration" ||
    statement.type === "ExportDefaultDeclaration"
      ? statement.declaration
      : statement;
  if (declaration === null || declaration === undefined) {
    return [];
  }
  if (
    (declaration.type === "FunctionDeclaration" ||
      declaration.type === "ClassDeclaration") &&
    declaration.id !== null
  ) {
    return [declaration.id.name];
  }
  if (declaration.type === "VariableDeclaration") {
    return declaration.declarations.flatMap((declarator) =>
      declarator.id.type === "Identifier" ? [declarator.id.name] : [],
    );
  }
  return [];
};

const referencedNames = (node: Node): Set<string> => {
  const names = new Set<string>();
  walk(node, (child) => {
    if (child.type === "Identifier" || child.type === "JSXIdentifier") {
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
    .map((statement) => ({
      statement,
      names: declaredNames(statement),
      references: referencedNames(statement),
    }));
  const reach = (roots: readonly Node[]): Set<Statement> => {
    const reached = new Set<Statement>();
    const pending = roots.flatMap((root) => [...referencedNames(root)]);
    const visited = new Set<string>();
    for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
      if (visited.has(name)) {
        continue;
      }
      visited.add(name);
      for (const declaration of declarations) {
        if (declaration.names.includes(name)) {
          reached.add(declaration.statement);
          pending.push(...declaration.references);
        }
      }
    }
    return reached;
  };
  const data = reach(route.data);
  return [...reach([route.component])]
    .filter((statement) => !data.has(statement))
    .map((statement) => [
      parsed.locate(statement.start).line - 1,
      parsed.locate(statement.end).line - 1,
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
    // runtime, a re-export facade, a bundled worker. Its bytes still count;
    // it has no modules to attribute them to.
    return {
      chunk: {
        fileName,
        gzipBytes: Bun.gzipSync(raw).length,
        codeBytes: code.length,
        modules: new Map(),
        staticImports,
        dynamicImports: [],
      },
      routeComponentBytes: new Map(),
    };
  }
  const map = v.parse(
    SourceMapSchema,
    JSON.parse(readFileSync(mapFile, "utf-8")),
  );
  const ids = map.sources.map(appRelative);
  // An initial route file's component declarations, by source index.
  const componentLines = new Map<number, LineRange[]>();
  if (initial) {
    for (const [index, id] of ids.entries()) {
      const content = map.sourcesContent?.[index];
      if (
        typeof content === "string" &&
        id.startsWith(ROUTES_PREFIX) &&
        !id.includes("?")
      ) {
        const ranges = componentDeclarationLines(id, content);
        if (ranges.length > 0) {
          componentLines.set(index, ranges);
        }
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
      codeBytes: code.length,
      modules,
      staticImports,
      dynamicImports,
    },
    routeComponentBytes,
  };
};

const readRoutes = (
  manifest: Manifest,
  appRoot: string,
): StartupRoute[] | string => {
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
      preloads: (route.preloads ?? []).map(chunkFileName),
    });
  }
  return routes;
};

export const readStartupGraph = async (
  distDir: string,
): Promise<ReadResult> => {
  const manifest = await readManifest(distDir);
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
  const initial = new Set(initialChunks);

  const assetsDir = path.join(distDir, CLIENT_ASSETS);
  const chunks = new Map<string, BuiltChunk>();
  const routeComponentBytes = new Map<string, number>();
  for (const fileName of new Bun.Glob("*.js").scanSync(assetsDir)) {
    const read = readChunk(assetsDir, fileName, initial.has(fileName));
    if (typeof read === "string") {
      return { ok: false, error: read };
    }
    chunks.set(fileName, read.chunk);
    for (const [id, bytes] of read.routeComponentBytes) {
      routeComponentBytes.set(id, (routeComponentBytes.get(id) ?? 0) + bytes);
    }
  }
  const missing = initialChunks.filter((file) => !chunks.has(file));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Initial chunk(s) missing from ${assetsDir}: ${missing.join(", ")}`,
    };
  }
  return {
    ok: true,
    graph: { initialChunks, chunks, routes, routeComponentBytes },
  };
};
