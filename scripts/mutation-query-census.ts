import { toKebabCase } from "@better-auth/core/utils/string";
import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

import { compareCodeUnit } from "@stll/collation";

const MUTATIONS = new Set(["useMutation", "mutationOptions"]);
const ROUTE_READER_HELPERS = new Set([
  "ensureRouteQueryData",
  "ensureRouteInfiniteQueryData",
]);
const READERS = new Set([
  ...ROUTE_READER_HELPERS,
  "queryOptions",
  "infiniteQueryOptions",
  "useQuery",
  "useSuspenseQuery",
  "useInfiniteQuery",
  "useSuspenseInfiniteQuery",
  "fetchQuery",
  "prefetchQuery",
  "ensureQueryData",
  "fetchInfiniteQuery",
  "prefetchInfiniteQuery",
  "query",
  "infiniteQuery",
  "ensureInfiniteQueryData",
]);
const AMBIGUOUS_READER_NAMES = new Set(["query", "infiniteQuery"]);
const READER_FACTORIES = new Set(["queryOptions", "infiniteQueryOptions"]);
const CACHE_EFFECTS = new Set([
  "invalidateQueries",
  "setQueryData",
  "setQueriesData",
  "resetQueries",
  "removeQueries",
]);
const METHODS = new Set(["get", "post", "put", "patch", "delete", "head"]);
const EXCLUDED_DIRECTORIES = new Set([
  "__tests__",
  "__fixtures__",
  "fixtures",
  "test-fixtures",
  "e2e",
]);

export const isMutationQueryCensusSource = (file: string) => {
  const filename = path.posix.basename(file);
  if (
    filename.endsWith(".d.ts") ||
    /\.(?:test|spec|type-test|test-fixtures|fixtures?)\.[cm]?[jt]sx?$/u.test(
      filename,
    )
  ) {
    return false;
  }
  const stem = filename.replace(/\.[cm]?[jt]sx?$/u, "");
  if (
    stem !== filename &&
    stem.endsWith("-test-fixtures") &&
    !/\s/u.test(filename)
  ) {
    return false;
  }
  return !file
    .split("/")
    .slice(1, -1)
    .some((segment) => EXCLUDED_DIRECTORIES.has(segment));
};

type SourceInput = { file: string; text: string };
type Environment = Map<ts.Node, Value>;
type Value = { node: ts.Node; env: Environment };
type ImportBinding = { module: string; imported: string };
type Binding = {
  name: string;
  node: ts.Node;
  value?: ts.Node | undefined;
  scope: ts.Node;
};
type Module = {
  source: ts.SourceFile;
  file: string;
  bindings: Binding[];
  imports: Map<string, ImportBinding>;
  exports: Map<string, ts.Node>;
  reexports: Map<string, ImportBinding>;
  exportStars: string[];
};

export type CensusKey = {
  expression: string;
  factory: string | null;
  staticPrefix: string[];
  unresolved: boolean;
};
export type CensusRoute = {
  file: string;
  route: string;
  method: string;
  expression: string;
};
export type CensusUnresolved = {
  reason: string;
  expression: string;
  file: string;
};
export type CensusCacheEffect = {
  operation: string;
  file: string;
  key: CensusKey | null;
  expression: string;
};
type CensusLocation = {
  id: string;
  file: string;
  line: number;
  column: number;
  callee: string;
};
export type MutationCensusEntry = CensusLocation & {
  kind: "useMutation" | "mutationOptions" | "wrapper";
  wrapperOf: string[];
  writes: CensusRoute[];
  ownWrites: CensusRoute[];
  cacheEffects: CensusCacheEffect[];
  readerIds: string[];
  unresolved: CensusUnresolved[];
  ownUnresolved: CensusUnresolved[];
};
export type QueryReaderCensusEntry = CensusLocation & {
  kind: string;
  wrapperOf: string[];
  key: CensusKey | null;
  routes: CensusRoute[];
  unresolved: CensusUnresolved[];
};

const normalize = (node: ts.Node) =>
  node.getText().replace(/\s+/gu, " ").trim();
const unwrap = (node: ts.Node): ts.Node => {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return unwrap(node.expression);
  }
  return node;
};
const functionNode = (
  node: ts.Node,
): node is
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node);
const propertyName = (node: ts.Node): string | undefined => {
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  if (ts.isComputedPropertyName(node)) {
    return propertyName(node.expression);
  }
  return undefined;
};
const callName = (node: ts.Node): string | undefined => {
  const value = unwrap(node);
  if (ts.isIdentifier(value)) {
    return value.text;
  }
  if (ts.isPropertyAccessExpression(value)) {
    return value.name.text;
  }
  if (ts.isElementAccessExpression(value)) {
    return propertyName(value.argumentExpression);
  }
  return undefined;
};
const readerOptionsIndex = (primitive: string | undefined): number =>
  ROUTE_READER_HELPERS.has(primitive ?? "") ? 1 : 0;
const nearestScope = (node: ts.Node): ts.Node => {
  let scope = node.parent;
  while (
    !ts.isBlock(scope) &&
    !ts.isSourceFile(scope) &&
    !functionNode(scope)
  ) {
    scope = scope.parent;
  }
  return scope;
};
const ancestors = (node: ts.Node) => {
  const result: ts.Node[] = [];
  for (let current = node; ; current = current.parent) {
    result.push(current);
    if (ts.isSourceFile(current)) {
      break;
    }
  }
  return result;
};
const indexModule = ({ file, text }: SourceInput): Module => {
  // parse-memo intentionally shares equal text across filenames; this graph needs file identity.
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/u.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings: Binding[] = [];
  const imports = new Map<string, ImportBinding>();
  const exports = new Map<string, ts.Node>();
  const reexports = new Map<string, ImportBinding>();
  const exportStars: string[] = [];
  const visitImport = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      const module = node.moduleSpecifier.text;
      if (clause?.name) {
        imports.set(clause.name.text, { module, imported: "default" });
      }
      const named = clause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const item of named.elements) {
          imports.set(item.name.text, {
            module,
            imported: (item.propertyName ?? item.name).text,
          });
        }
      }
      if (named && ts.isNamespaceImport(named)) {
        imports.set(named.name.text, { module, imported: "*" });
      }
    }
  };
  const visit = (node: ts.Node) => {
    visitImport(node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      bindings.push({
        name: node.name.text,
        node,
        value: node.initializer,
        scope: nearestScope(node),
      });
      if (nearestScope(node) === source && node.initializer) {
        exports.set(node.name.text, node.initializer);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer)
    ) {
      const imported = imports.get(node.initializer.text);
      if (imported?.imported === "*") {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name)) {
            imports.set(element.name.text, {
              module: imported.module,
              imported: element.propertyName
                ? (propertyName(element.propertyName) ?? element.name.text)
                : element.name.text,
            });
          }
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      bindings.push({
        name: node.name.text,
        node,
        value: node,
        scope: nearestScope(node),
      });
      if (nearestScope(node) === source) {
        exports.set(node.name.text, node);
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      bindings.push({ name: node.name.text, node, scope: node.parent });
    }
    if (ts.isExportAssignment(node)) {
      exports.set("default", node.expression);
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const module = node.moduleSpecifier.text;
      if (!node.exportClause) {
        exportStars.push(module);
      } else if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          reexports.set(element.name.text, {
            module,
            imported: (element.propertyName ?? element.name).text,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const statement of source.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      const name = (element.propertyName ?? element.name).text;
      const local = exports.get(name);
      if (local) {
        exports.set(element.name.text, local);
      }
      const imported = imports.get(name);
      if (imported) {
        reexports.set(element.name.text, imported);
      }
    }
  }
  return { source, file, bindings, imports, exports, reexports, exportStars };
};

const mutationKind = (
  primitive: string | undefined,
): MutationCensusEntry["kind"] => {
  switch (primitive) {
    case "useMutation":
      return "useMutation";
    case "mutationOptions":
      return "mutationOptions";
    case undefined:
      return "wrapper";
    default:
      return "wrapper";
  }
};

type ExportedFromArgs = {
  module: Module | undefined;
  name: string;
  seen?: Set<string>;
};
type ImportedPrimitiveArgs = {
  from: string;
  imported: ImportBinding;
  seen?: Set<string>;
};

type ScanCallArgs = {
  current: Value & { node: ts.CallExpression };
  depth: number;
  nextActive: Set<ts.Node>;
};

type ScanArgs = {
  value: Value;
  depth: number;
  active?: Set<ts.Node>;
};

type CallScanMode = "transitive" | "outside-mutations";

class CallScanner {
  readonly analyzer;
  readonly mode;
  constructor(analyzer: CensusAnalyzer, mode: CallScanMode) {
    this.analyzer = analyzer;
    this.mode = mode;
  }
  readonly routes: CensusRoute[] = [];
  readonly effects: CensusCacheEffect[] = [];
  readonly unresolved: CensusUnresolved[] = [];
  readonly wrapperOf = new Set<string>();
  readonly readerOf = new Set<string>();
  readonly readerOptions: Value[] = [];
  readonly visited = new Set<string>();
  readonly scanned = new Set<string>();
  readonly optionsNodes = new Set<ts.Node>();
  deduplicate = <T>(items: T[]) =>
    items.filter((item) => {
      const key = JSON.stringify(item);
      if (this.visited.has(key)) {
        return false;
      }
      this.visited.add(key);
      return true;
    });
  unknown = (reason: string, node: ts.Node) =>
    this.unresolved.push({
      reason,
      file: node.getSourceFile().fileName,
      expression: normalize(node),
    });
  scanCall = ({ current, depth, nextActive }: ScanCallArgs) => {
    const node = current.node;
    const name = this.analyzer.primitiveName(node);
    switch (this.mode) {
      case "transitive":
        break;
      case "outside-mutations":
        if (MUTATIONS.has(name ?? "")) {
          return;
        }
        break;
      default:
        this.mode satisfies never;
        panic("Unhandled mutation census scan mode");
    }
    if (
      this.mode === "outside-mutations" &&
      this.analyzer.isResourceMutationFactory(node)
    ) {
      const options = node.arguments.at(0);
      if (options) {
        this.scanFactoryOptions({
          value: { node: options, env: current.env },
          depth: depth + 1,
          active: nextActive,
        });
      }
      return;
    }
    const route = this.analyzer.routeOf(node);
    if (!route && this.analyzer.authClientOperation(node)) {
      this.unknown("unresolved-auth-plugin-endpoint", node);
    }
    if (this.analyzer.isExecutingReader(node)) {
      this.readerOf.add(this.analyzer.location(node).id);
      const argument = node.arguments.at(
        ROUTE_READER_HELPERS.has(name ?? "") ? 1 : 0,
      );
      if (argument) {
        const options = this.analyzer.optionsOf({
          node: argument,
          env: current.env,
        });
        this.readerOptions.push(options);
        this.optionsNodes.add(options.node);
        this.scan({ value: options, depth: depth + 1, active: nextActive });
      } else {
        this.unknown("reader-options-missing", node);
      }
      return;
    }
    if (route) {
      this.routes.push(route);
    }
    if (CACHE_EFFECTS.has(name ?? "")) {
      const argument = node.arguments.at(0);
      const key =
        argument &&
        (name === "setQueryData"
          ? { node: argument, env: current.env }
          : this.analyzer.property(
              { node: argument, env: current.env },
              "queryKey",
            ));
      this.effects.push({
        operation: name ?? "",
        file: node.getSourceFile().fileName,
        key: key ? this.analyzer.keyOf(key) : null,
        expression: normalize(node),
      });
      if (!key) {
        this.unknown("cache-effect-without-static-key", node);
      }
    }
    if (MUTATIONS.has(name ?? "")) {
      this.wrapperOf.add(this.analyzer.location(node).id);
      const argument = node.arguments.at(0);
      if (argument) {
        const options = this.analyzer.optionsOf({
          node: argument,
          env: current.env,
        });
        this.optionsNodes.add(options.node);
        this.scan({ value: options, depth: depth + 1, active: nextActive });
      } else {
        this.unknown("mutation-options-missing", node);
      }
      return;
    }
    if (!route && !CACHE_EFFECTS.has(name ?? "")) {
      const helperTarget = this.analyzer.resolve({
        node: node.expression,
        env: current.env,
      });
      const body = this.analyzer.effectFunctions.has(helperTarget.node)
        ? this.analyzer.invocation(node, current.env)
        : undefined;
      if (body) {
        this.scan({ value: body, depth: depth + 1, active: nextActive });
      }
    }
    for (const argument of node.arguments) {
      this.scan({
        value: { node: argument, env: current.env },
        depth,
        active: nextActive,
      });
    }
    return;
  };
  scanFactoryOptions = ({ value, depth, active = new Set() }: ScanArgs) => {
    if (depth > 12) {
      this.unknown("helper-depth-limit", value.node);
      return;
    }
    if (active.has(value.node)) {
      this.unknown("dynamic-options-spread", value.node);
      return;
    }
    const options = this.analyzer.resolve(value);
    if (!ts.isObjectLiteralExpression(options.node)) {
      this.scan({ value: options, depth, active });
      return;
    }
    const nextActive = new Set(active).add(options.node);
    for (const property of options.node.properties) {
      if (ts.isSpreadAssignment(property)) {
        this.scanFactoryOptions({
          value: { node: property.expression, env: options.env },
          depth: depth + 1,
          active: nextActive,
        });
        continue;
      }
      if (
        ts.isPropertyAssignment(property) &&
        propertyName(property.name) === "mutationFn" &&
        functionNode(
          this.analyzer.resolve({
            node: property.initializer,
            env: options.env,
          }).node,
        )
      ) {
        continue;
      }
      this.scan({
        value: { node: property, env: options.env },
        depth,
        active: nextActive,
      });
    }
  };
  scan = ({ value, depth, active = new Set<ts.Node>() }: ScanArgs) => {
    const current = value;
    const node = current.node;
    if (active.has(node)) {
      return;
    }
    if (depth > 12) {
      this.unknown("helper-depth-limit", node);
      return;
    }
    const signature = `${node.getSourceFile().fileName}:${String(node.kind)}:${String(node.pos)}:${String(node.end)}:${[...current.env.entries()].map(([parameter, argument]) => `${parameter.getSourceFile().fileName}:${String(parameter.pos)}=${argument.node.getSourceFile().fileName}:${String(argument.node.pos)}`).join(";")}`;
    if (this.scanned.has(signature)) {
      return;
    }
    this.scanned.add(signature);
    const nextActive = new Set(active).add(node);
    if (ts.isCallExpression(node)) {
      this.scanCall({ current: { node, env: current.env }, depth, nextActive });
      return;
    }
    if (ts.isSpreadAssignment(node)) {
      const spread = this.analyzer.resolve({
        node: node.expression,
        env: current.env,
      });
      if (
        !ts.isObjectLiteralExpression(spread.node) &&
        this.optionsNodes.has(node.parent)
      ) {
        this.unknown("dynamic-options-spread", node.expression);
      } else {
        this.scan({ value: spread, depth: depth + 1, active: nextActive });
      }
      return;
    }
    if (
      ts.isPropertyAssignment(node) &&
      [
        "mutationFn",
        "queryFn",
        "onSuccess",
        "onSettled",
        "onMutate",
        "onError",
      ].includes(propertyName(node.name) ?? "")
    ) {
      const fn = this.analyzer.resolve({
        node: node.initializer,
        env: current.env,
      });
      if (
        !functionNode(fn.node) &&
        ["mutationFn", "queryFn"].includes(propertyName(node.name) ?? "")
      ) {
        this.unknown("dynamic-operation-function", node.initializer);
      }
      this.scan({
        value: {
          node: functionNode(fn.node) && fn.node.body ? fn.node.body : fn.node,
          env: fn.env,
        },
        depth: depth + 1,
        active: nextActive,
      });
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (
          declaration.initializer &&
          !functionNode(unwrap(declaration.initializer))
        ) {
          this.scan({
            value: { node: declaration.initializer, env: current.env },
            depth,
            active: nextActive,
          });
        }
      }
      return;
    }
    if (ts.isFunctionDeclaration(node)) {
      return;
    }
    // Function arguments and lifecycle callbacks can execute; uncalled local declarations cannot.
    if (functionNode(node) && node.body) {
      this.scan({
        value: { node: node.body, env: current.env },
        depth,
        active: nextActive,
      });
      return;
    }
    ts.forEachChild(node, (child) =>
      this.scan({
        value: { node: child, env: current.env },
        depth,
        active: nextActive,
      }),
    );
  };
}

type MutationOwnershipArgs = {
  call: ts.CallExpression;
  writes: CensusRoute[];
  unresolved: CensusUnresolved[];
};

class CensusAnalyzer {
  readonly modules;
  readonly packageExports;
  readonly calls: ts.CallExpression[] = [];
  readonly mutationFunctions = new Set<ts.Node>();
  readonly readerFunctions = new Set<ts.Node>();
  readonly effectFunctions = new Set<ts.Node>();
  readonly authPluginRoutes;
  readonly mutations: MutationCensusEntry[] = [];
  readonly readers: QueryReaderCensusEntry[] = [];
  targets = new Map<ts.CallExpression, ts.Node>();
  primitiveNames = new Map<ts.CallExpression, string | undefined>();
  constructor(
    inputs: readonly SourceInput[],
    packageExports: ReadonlyMap<string, string>,
  ) {
    this.packageExports = packageExports;
    this.modules = new Map(
      inputs.map((input) => [input.file, indexModule(input)]),
    );
    const contracts = this.modules
      .get("apps/web/src/lib/workspace-realtime.ts")
      ?.exports.get("RESOURCE_MUTATION_CONTRACTS");
    const routes = new Map<string, string | undefined>();
    const value = contracts ? unwrap(contracts) : undefined;
    const properties =
      value && ts.isObjectLiteralExpression(value) ? value.properties : [];
    for (const contract of properties) {
      if (!ts.isPropertyAssignment(contract)) {
        continue;
      }
      const writes = this.property(
        { node: contract.initializer, env: new Map() },
        "writes",
      );
      const entries = writes ? unwrap(writes.node) : undefined;
      if (!entries || !ts.isArrayLiteralExpression(entries)) {
        continue;
      }
      for (const entry of entries.elements) {
        const node = unwrap(entry);
        if (!ts.isObjectLiteralExpression(node)) {
          continue;
        }
        const fields = new Map(
          node.properties
            .filter(ts.isPropertyAssignment)
            .map((property) => [
              propertyName(property.name),
              unwrap(property.initializer),
            ]),
        );
        const type = fields.get("type");
        const method = fields.get("method");
        const route = fields.get("route");
        if (
          type &&
          ts.isStringLiteral(type) &&
          type.text === "auth-plugin-endpoint" &&
          method &&
          ts.isStringLiteral(method) &&
          route &&
          ts.isStringLiteral(route)
        ) {
          const normalized = method.text.toLowerCase();
          routes.set(
            route.text,
            routes.has(route.text) && routes.get(route.text) !== normalized
              ? undefined
              : normalized,
          );
        }
      }
    }
    this.authPluginRoutes = routes;
  }
  authClientOperation = (call: ts.CallExpression) => {
    const parts: string[] = [];
    let node = unwrap(call.expression);
    let shape: "static" | "dynamic" = "static";
    while (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isCallExpression(node)
    ) {
      if (ts.isPropertyAccessExpression(node)) {
        parts.unshift(node.name.text);
      } else if (ts.isElementAccessExpression(node)) {
        if (ts.isStringLiteral(node.argumentExpression)) {
          parts.unshift(node.argumentExpression.text);
        } else {
          shape = "dynamic";
        }
      } else {
        shape = "dynamic";
      }
      node = unwrap(node.expression);
    }
    if (!ts.isIdentifier(node)) {
      return undefined;
    }
    const module = this.moduleFor(node);
    const imported = module?.imports.get(node.text);
    const from =
      module && imported
        ? this.moduleBase(module.file, imported.module)
        : undefined;
    const canonical = from === "apps/web/src/lib/auth-client";
    const named = imported?.imported === "authClient";
    const namespace =
      imported?.imported === "*" && canonical && parts.shift() === "authClient";
    if (!named && !namespace && !canonical && node.text !== "authClient") {
      return undefined;
    }
    if (
      !canonical ||
      (!named && !namespace) ||
      this.bindingFor(node) ||
      shape === "dynamic"
    ) {
      return { type: "unproven" } as const;
    }
    return {
      type: "proven",
      route: `/${parts.map(toKebabCase).join("/")}`,
    } as const;
  };
  moduleFor = (node: ts.Node) =>
    this.modules.get(node.getSourceFile().fileName);
  isResourceMutationFactory = (call: ts.CallExpression) => {
    const module = this.moduleFor(call);
    if (!module) {
      return false;
    }
    const expression = unwrap(call.expression);
    if (ts.isIdentifier(expression)) {
      const imported = module.imports.get(expression.text);
      const target = imported
        ? this.resolveModule(module.file, imported.module)
        : undefined;
      return (
        this.bindingFor(expression) === undefined &&
        imported?.imported === "resourceMutation" &&
        target?.file === "apps/web/src/lib/workspace-realtime.ts" &&
        this.exportedFrom({ module: target, name: "resourceMutation" }) !==
          undefined
      );
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const owner = unwrap(expression.expression);
      if (!ts.isIdentifier(owner)) {
        return false;
      }
      const imported = module.imports.get(owner.text);
      const target = imported
        ? this.resolveModule(module.file, imported.module)
        : undefined;
      return (
        this.bindingFor(owner) === undefined &&
        imported?.imported === "*" &&
        expression.name.text === "resourceMutation" &&
        target?.file === "apps/web/src/lib/workspace-realtime.ts" &&
        this.exportedFrom({ module: target, name: "resourceMutation" }) !==
          undefined
      );
    }
    return false;
  };
  moduleBase = (from: string, specifier: string) => {
    const exported = this.packageExports.get(specifier);
    if (exported !== undefined) {
      return exported;
    }
    if (specifier.startsWith("@/")) {
      return `apps/web/src/${specifier.slice(2)}`;
    }
    if (specifier.startsWith(".")) {
      return path.posix.normalize(
        path.posix.join(path.posix.dirname(from), specifier),
      );
    }
    if (specifier.startsWith("@stll/")) {
      const segments = specifier.slice(6).split("/");
      return `packages/${String(segments.at(0))}/src/${segments.slice(1).join("/") || "index"}`;
    }
    return undefined;
  };
  resolveModule = (from: string, specifier: string) => {
    const base = this.moduleBase(from, specifier);
    if (!base) {
      return undefined;
    }
    return [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
    ]
      .map((candidate) => this.modules.get(candidate))
      .find((candidate) => candidate !== undefined);
  };
  bindingFor = (identifier: ts.Identifier) => {
    const module = this.moduleFor(identifier);
    if (!module) {
      return undefined;
    }
    for (const scope of ancestors(identifier)) {
      const binding = module.bindings.findLast(
        (candidate) =>
          candidate.name === identifier.text && candidate.scope === scope,
      );
      if (binding) {
        return binding;
      }
    }
    return undefined;
  };
  exportedFrom = ({
    module,
    name,
    seen = new Set<string>(),
  }: ExportedFromArgs): ts.Node | undefined => {
    if (!module || seen.has(`${module.file}:${name}`)) {
      return undefined;
    }
    seen.add(`${module.file}:${name}`);
    const direct = module.exports.get(name);
    if (direct) {
      return direct;
    }
    const reexport = module.reexports.get(name);
    if (reexport) {
      return this.exportedFrom({
        module: this.resolveModule(module.file, reexport.module),
        name: reexport.imported,
        seen,
      });
    }
    for (const specifier of module.exportStars) {
      const found = this.exportedFrom({
        module: this.resolveModule(module.file, specifier),
        name,
        seen,
      });
      if (found) {
        return found;
      }
    }
    return undefined;
  };
  importedPrimitive = ({
    from,
    imported,
    seen = new Set<string>(),
  }: ImportedPrimitiveArgs): string | undefined => {
    if (imported.module.startsWith("@tanstack/")) {
      return imported.imported;
    }
    const module = this.resolveModule(from, imported.module);
    if (!module || seen.has(`${module.file}:${imported.imported}`)) {
      return undefined;
    }
    seen.add(`${module.file}:${imported.imported}`);
    const reexport = module.reexports.get(imported.imported);
    if (reexport) {
      return this.importedPrimitive({
        from: module.file,
        imported: reexport,
        seen,
      });
    }
    for (const specifier of module.exportStars) {
      const found = this.importedPrimitive({
        from: module.file,
        imported: { module: specifier, imported: imported.imported },
        seen,
      });
      if (found) {
        return found;
      }
    }
    return undefined;
  };
  resolve = (value: Value, seen = new Set<ts.Node>()): Value => {
    const node = unwrap(value.node);
    if (seen.has(node)) {
      return { node, env: value.env };
    }
    seen.add(node);
    if (ts.isIdentifier(node)) {
      const binding = this.bindingFor(node);
      if (binding) {
        const argument = value.env.get(binding.node);
        if (argument) {
          return this.resolve(argument, seen);
        }
        if (binding.value && binding.value !== node) {
          return this.resolve({ node: binding.value, env: value.env }, seen);
        }
        return { node, env: value.env };
      }
      const imported = this.moduleFor(node)?.imports.get(node.text);
      if (imported) {
        const exported = this.exportedFrom({
          module: this.resolveModule(
            node.getSourceFile().fileName,
            imported.module,
          ),
          name: imported.imported,
        });
        if (exported) {
          return this.resolve({ node: exported, env: value.env }, seen);
        }
      }
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : propertyName(node.argumentExpression);
      const owner = this.resolve(
        { node: node.expression, env: value.env },
        seen,
      );
      if (name && ts.isObjectLiteralExpression(owner.node)) {
        const foundProperty = owner.node.properties.find(
          (candidate) =>
            candidate.name && propertyName(candidate.name) === name,
        );
        if (foundProperty && ts.isPropertyAssignment(foundProperty)) {
          return this.resolve(
            { node: foundProperty.initializer, env: owner.env },
            seen,
          );
        }
        if (foundProperty && ts.isMethodDeclaration(foundProperty)) {
          return { node: foundProperty, env: owner.env };
        }
      }
      if (name && ts.isIdentifier(node.expression)) {
        const imported = this.moduleFor(node)?.imports.get(
          node.expression.text,
        );
        if (imported?.imported === "*") {
          const exported = this.exportedFrom({
            module: this.resolveModule(
              node.getSourceFile().fileName,
              imported.module,
            ),
            name,
          });
          if (exported) {
            return this.resolve({ node: exported, env: value.env }, seen);
          }
        }
      }
    }
    return { node, env: value.env };
  };
  invocation = (
    call: ts.CallExpression,
    env: Environment,
  ): Value | undefined => {
    const target = this.resolve({ node: call.expression, env });
    if (!functionNode(target.node) || !target.node.body) {
      return undefined;
    }
    const next = new Map(target.env);
    for (const [index, parameter] of target.node.parameters.entries()) {
      const argument = call.arguments.at(index) ?? parameter.initializer;
      if (argument) {
        next.set(parameter, { node: argument, env });
      }
    }
    return { node: target.node.body, env: next };
  };
  primitiveName = (call: ts.CallExpression): string | undefined => {
    const name = callName(call.expression);
    if (!name) {
      return undefined;
    }
    if (ts.isIdentifier(call.expression)) {
      const canonical = this.resolve({
        node: call.expression,
        env: new Map(),
      }).node;
      if (ts.isIdentifier(canonical)) {
        const imported = this.moduleFor(canonical)?.imports.get(canonical.text);
        const primitive =
          imported &&
          this.importedPrimitive({
            from: canonical.getSourceFile().fileName,
            imported,
          });
        if (primitive) {
          return primitive;
        }
      }
      const binding = this.bindingFor(call.expression);
      if (binding?.value && ts.isIdentifier(unwrap(binding.value))) {
        const fake = unwrap(binding.value);
        if (ts.isIdentifier(fake)) {
          const imported = this.moduleFor(fake)?.imports.get(fake.text);
          const primitive =
            imported &&
            this.importedPrimitive({
              from: fake.getSourceFile().fileName,
              imported,
            });
          if (primitive) {
            return primitive;
          }
        }
      }
      const imported = this.moduleFor(call)?.imports.get(name);
      const primitive =
        imported &&
        this.importedPrimitive({
          from: call.getSourceFile().fileName,
          imported,
        });
      if (primitive) {
        return primitive;
      }
    }
    // Preserve unfamiliar spellings as census members rather than losing a new shape.
    return name;
  };
  returned = (value: Value): Value | undefined => {
    if (!ts.isBlock(value.node)) {
      return value;
    }
    const statement = value.node.statements.find(ts.isReturnStatement);
    return statement?.expression
      ? { node: statement.expression, env: value.env }
      : undefined;
  };
  optionsOf = (value: Value, depth = 0): Value => {
    const current = this.resolve(value);
    if (!ts.isCallExpression(current.node) || depth > 12) {
      return current;
    }
    const primitive = this.primitiveName(current.node);
    if (READERS.has(primitive ?? "") || MUTATIONS.has(primitive ?? "")) {
      const argument = current.node.arguments.at(0);
      return argument
        ? this.optionsOf({ node: argument, env: current.env }, depth + 1)
        : current;
    }
    const body = this.invocation(current.node, current.env);
    const result = body && this.returned(body);
    return result ? this.optionsOf(result, depth + 1) : current;
  };
  keyOf = (value: Value, depth = 0): CensusKey => {
    const expression = normalize(value.node);
    if (depth > 12) {
      return { expression, factory: null, staticPrefix: [], unresolved: true };
    }
    const current = this.resolve(value);
    if (ts.isCallExpression(current.node)) {
      const body = this.invocation(current.node, current.env);
      const result = body && this.returned(body);
      const key = result && this.keyOf(result, depth + 1);
      return {
        expression,
        factory: normalize(current.node.expression),
        staticPrefix: key?.staticPrefix ?? [],
        unresolved: key?.unresolved ?? true,
      };
    }
    if (ts.isArrayLiteralExpression(current.node)) {
      const staticPrefix: string[] = [];
      let unresolved = false;
      for (const element of current.node.elements) {
        if (ts.isSpreadElement(element)) {
          const key = this.keyOf(
            { node: element.expression, env: current.env },
            depth + 1,
          );
          staticPrefix.push(...key.staticPrefix);
          if (key.unresolved) {
            unresolved = true;
            break;
          }
          continue;
        }
        const part = this.resolve({ node: element, env: current.env }).node;
        if (
          ts.isStringLiteral(part) ||
          ts.isNumericLiteral(part) ||
          ts.isNoSubstitutionTemplateLiteral(part)
        ) {
          staticPrefix.push(part.text);
          continue;
        }
        unresolved = true;
        break;
      }
      return {
        expression,
        factory: current.node === value.node ? null : expression,
        staticPrefix,
        unresolved,
      };
    }
    return { expression, factory: null, staticPrefix: [], unresolved: true };
  };
  property = (value: Value, name: string): Value | undefined => {
    const current = this.optionsOf(value);
    if (!ts.isObjectLiteralExpression(current.node)) {
      return undefined;
    }
    for (const item of current.node.properties.toReversed()) {
      if (ts.isSpreadAssignment(item)) {
        const found = this.property(
          { node: item.expression, env: current.env },
          name,
        );
        if (found) {
          return found;
        }
      }
      if (!item.name || propertyName(item.name) !== name) {
        continue;
      }
      if (ts.isPropertyAssignment(item)) {
        return { node: item.initializer, env: current.env };
      }
      if (ts.isShorthandPropertyAssignment(item)) {
        return { node: item.name, env: current.env };
      }
      if (ts.isMethodDeclaration(item)) {
        return { node: item, env: current.env };
      }
    }
    return undefined;
  };
  routeOf = (call: ts.CallExpression): CensusRoute | undefined => {
    const auth = this.authClientOperation(call);
    if (auth) {
      const method =
        auth.type === "proven"
          ? this.authPluginRoutes.get(auth.route)
          : undefined;
      return auth.type === "proven" && method
        ? {
            file: call.getSourceFile().fileName,
            route: auth.route,
            method,
            expression: normalize(call),
          }
        : undefined;
    }
    const method = callName(call.expression);
    if (
      !method ||
      !METHODS.has(method) ||
      !ts.isPropertyAccessExpression(call.expression)
    ) {
      return undefined;
    }
    const parts: string[] = [];
    let node: ts.Expression = call.expression.expression;
    while (true) {
      if (ts.isPropertyAccessExpression(node)) {
        parts.unshift(node.name.text);
        node = node.expression;
        continue;
      }
      if (ts.isElementAccessExpression(node)) {
        parts.unshift(
          ts.isStringLiteral(node.argumentExpression)
            ? node.argumentExpression.text
            : ":dynamic",
        );
        node = node.expression;
        continue;
      }
      if (ts.isCallExpression(node)) {
        const argument = node.arguments.at(0);
        if (argument && ts.isObjectLiteralExpression(argument)) {
          for (const item of argument.properties.toReversed()) {
            parts.unshift(
              `:${item.name ? (propertyName(item.name) ?? "dynamic") : "dynamic"}`,
            );
          }
        } else {
          parts.unshift(":dynamic");
        }
        node = node.expression;
        continue;
      }
      if (!ts.isIdentifier(node)) {
        return undefined;
      }
      const imported = this.moduleFor(node)?.imports.get(node.text);
      if (
        !/(?:^api$|apiClient|^client$)/u.test(node.text) &&
        imported?.imported !== "api"
      ) {
        return undefined;
      }
      return {
        file: call.getSourceFile().fileName,
        route: `/${parts.join("/")}`,
        method,
        expression: normalize(call),
      };
    }
  };
  location = (call: ts.CallExpression): CensusLocation => {
    const names: string[] = [];
    for (const node of ancestors(call).toReversed()) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        names.push(node.name.text);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        names.push(node.name.text);
      }
      if (ts.isMethodDeclaration(node)) {
        names.push(propertyName(node.name) ?? "computed");
      }
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer))
      ) {
        names.push(propertyName(node.name) ?? "computed");
      }
    }
    const { line, character } = call
      .getSourceFile()
      .getLineAndCharacterOfPosition(call.getStart());
    const file = call.getSourceFile().fileName;
    const callee = normalize(call.expression);
    return {
      id: `${file}:${names.join("/") || "module"}:${callee}`,
      file,
      line: line + 1,
      column: character + 1,
      callee,
    };
  };
  collisions = new Map<string, number>();
  uniqueLocation = (call: ts.CallExpression) => {
    const entry = this.location(call);
    const count = (this.collisions.get(entry.id) ?? 0) + 1;
    this.collisions.set(entry.id, count);
    return count === 1 ? entry : { ...entry, id: `${entry.id}#${count}` };
  };
  collectCalls = () => {
    for (const module of this.modules.values()) {
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          this.calls.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(module.source);
    }
    // Fixed point: imported aliases and arbitrarily nested local wrappers retain their callers.
    const containingFunction = (node: ts.Node) =>
      ancestors(node).find(functionNode);
    this.targets = new Map(
      this.calls.map((call) => [
        call,
        this.resolve({ node: call.expression, env: new Map() }).node,
      ]),
    );
    this.primitiveNames = new Map(
      this.calls.map((call) => [call, this.primitiveName(call)]),
    );
    for (const call of this.calls) {
      if (
        !this.routeOf(call) &&
        !this.authClientOperation(call) &&
        !CACHE_EFFECTS.has(this.primitiveNames.get(call) ?? "") &&
        !MUTATIONS.has(this.primitiveNames.get(call) ?? "") &&
        !this.isExecutingReader(call)
      ) {
        continue;
      }
      for (const owner of ancestors(call).filter(functionNode)) {
        this.effectFunctions.add(owner);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const call of this.calls) {
        if (this.propagateReaderFunctions(call)) {
          changed = true;
        }
        const primitive = this.primitiveNames.get(call);
        const target = this.targets.get(call);
        if (target && this.effectFunctions.has(target)) {
          for (const owner of ancestors(call).filter(functionNode)) {
            if (!this.effectFunctions.has(owner)) {
              this.effectFunctions.add(owner);
              changed = true;
            }
          }
        }
        if (
          !MUTATIONS.has(primitive ?? "") &&
          !(target && this.mutationFunctions.has(target))
        ) {
          continue;
        }
        const owner = containingFunction(call);
        if (owner && !this.mutationFunctions.has(owner)) {
          this.mutationFunctions.add(owner);
          changed = true;
        }
      }
    }
  };
  isExecutingReader = (call: ts.CallExpression) => {
    const primitive = this.primitiveNames.get(call) ?? "";
    return (
      READERS.has(primitive) &&
      !READER_FACTORIES.has(primitive) &&
      this.readerDisposition(call) !== "excluded"
    );
  };
  propagateReaderFunctions = (call: ts.CallExpression) => {
    const target = this.targets.get(call);
    if (
      !this.isExecutingReader(call) &&
      !(target && this.readerFunctions.has(target))
    ) {
      return false;
    }
    let changed = false;
    for (const owner of ancestors(call).filter(functionNode)) {
      if (!this.readerFunctions.has(owner)) {
        this.readerFunctions.add(owner);
        changed = true;
      }
    }
    return changed;
  };
  classifyCall = (call: ts.CallExpression) => {
    const primitive = this.primitiveNames.get(call);
    const target = this.targets.get(call);
    const mutation =
      MUTATIONS.has(primitive ?? "") ||
      (target !== undefined && this.mutationFunctions.has(target));
    const readerDisposition = this.readerDisposition(call);
    const readerWrapper =
      target !== undefined && this.readerFunctions.has(target);
    const reader =
      (READERS.has(primitive ?? "") && readerDisposition !== "excluded") ||
      readerWrapper;
    return { primitive, mutation, readerDisposition, readerWrapper, reader };
  };
  mutationOwnership = ({ call, writes, unresolved }: MutationOwnershipArgs) => {
    if (MUTATIONS.has(this.primitiveName(call) ?? "")) {
      return { ownWrites: writes, ownUnresolved: unresolved };
    }
    const scanner = new CallScanner(this, "outside-mutations");
    const body = this.invocation(call, new Map());
    if (body) {
      scanner.scan({ value: body, depth: 0 });
    } else {
      scanner.unknown("unresolved-mutation-wrapper", call);
    }
    return {
      ownWrites: scanner.deduplicate(
        scanner.routes.filter(
          ({ method }) => method !== "get" && method !== "head",
        ),
      ),
      ownUnresolved: scanner.deduplicate(scanner.unresolved),
    };
  };
  analyzeCall = (call: ts.CallExpression) => {
    const { primitive, mutation, readerDisposition, readerWrapper, reader } =
      this.classifyCall(call);
    if (!mutation && !reader) {
      return;
    }
    const {
      routes,
      effects,
      unresolved,
      wrapperOf,
      readerOf,
      readerOptions,
      deduplicate,
      optionsNodes,
      unknown,
      scan,
    } = new CallScanner(this, "transitive");
    if (reader && !readerWrapper && readerDisposition === "ambiguous") {
      unknown("unresolved-query-client-receiver", call.expression);
    }
    const argument = call.arguments.at(readerOptionsIndex(primitive));
    const env: Environment = new Map();
    if ((mutation && !MUTATIONS.has(primitive ?? "")) || readerWrapper) {
      const body = this.invocation(call, env);
      if (body) {
        scan({ value: body, depth: 0 });
      } else {
        unknown(
          mutation
            ? "unresolved-mutation-wrapper"
            : "unresolved-reader-wrapper",
          call,
        );
      }
    } else if (argument) {
      const options = this.resolve({ node: argument, env });
      optionsNodes.add(options.node);
      if (
        !ts.isObjectLiteralExpression(options.node) &&
        !ts.isCallExpression(options.node)
      ) {
        unknown("dynamic-options", argument);
      }
      scan({ value: options, depth: 0 });
    } else {
      unknown("options-missing", call);
    }
    const callLocation = this.uniqueLocation(call);
    if (mutation) {
      const writes = deduplicate(
        routes.filter(({ method }) => method !== "get" && method !== "head"),
      );
      if (writes.length === 0) {
        unknown("no-static-write-route", call);
      }
      const allUnresolved = deduplicate(unresolved);
      this.mutations.push({
        ...callLocation,
        kind: mutationKind(primitive),
        wrapperOf: [...wrapperOf].toSorted(),
        writes,
        ...this.mutationOwnership({ call, writes, unresolved: allUnresolved }),
        cacheEffects: deduplicate(effects),
        readerIds: [],
        unresolved: allUnresolved,
      });
    }
    if (reader) {
      let options = argument && this.optionsOf({ node: argument, env });
      if (readerWrapper) {
        options = readerOptions.length === 1 ? readerOptions.at(0) : undefined;
      }
      const key = options && this.property(options, "queryKey");
      if (readerWrapper && readerOptions.length !== 1) {
        unknown("reader-wrapper-option-count-unresolved", call);
      }
      if (!key) {
        unknown("reader-key-unresolved", call);
      }
      this.readers.push({
        ...callLocation,
        kind: readerWrapper ? "wrapper" : (primitive ?? "unknown"),
        wrapperOf: [...readerOf].toSorted(),
        key: key ? this.keyOf(key) : null,
        routes: deduplicate(routes),
        unresolved: deduplicate(unresolved),
      });
    }
  };
  readerDisposition = (
    call: ts.CallExpression,
  ): "known" | "ambiguous" | "excluded" => {
    const primitive = this.primitiveNames.get(call);
    if (!AMBIGUOUS_READER_NAMES.has(primitive ?? "")) {
      return "known";
    }
    const target = this.targets.get(call);
    if (target && functionNode(target)) {
      return "excluded";
    }
    // QueryClient requires options; a zero-argument query on an unknown
    // receiver belongs to another API, such as the browser's LockManager.
    const unresolvedDisposition =
      call.arguments.length === 0 ? "excluded" : "ambiguous";
    const expression = unwrap(call.expression);
    if (
      !ts.isPropertyAccessExpression(expression) &&
      !ts.isElementAccessExpression(expression)
    ) {
      return unresolvedDisposition;
    }
    const receiver = this.resolve({
      node: expression.expression,
      env: new Map(),
    }).node;
    if (
      ts.isCallExpression(receiver) &&
      this.primitiveName(receiver) === "useQueryClient"
    ) {
      return "known";
    }
    if (
      !ts.isNewExpression(receiver) ||
      !ts.isIdentifier(receiver.expression)
    ) {
      return unresolvedDisposition;
    }
    const imported = this.moduleFor(receiver)?.imports.get(
      receiver.expression.text,
    );
    return imported?.module.startsWith("@tanstack/") &&
      imported.imported === "QueryClient"
      ? "known"
      : unresolvedDisposition;
  };
  analyze = () => {
    this.collectCalls();
    for (const call of this.calls) {
      this.analyzeCall(call);
    }
    const family = (route: string) =>
      route.split("/").find((part) => part && !part.startsWith(":"));
    for (const mutation of this.mutations) {
      const families = new Set(
        mutation.writes.map(({ route }) => family(route)),
      );
      mutation.readerIds = this.readers
        .filter((reader) =>
          reader.routes.some(({ route }) => families.has(family(route))),
        )
        .map(({ id }) => id)
        .toSorted();
    }
    const realtimeModule = this.modules.get(
      "apps/web/src/lib/workspace-realtime.ts",
    );
    const realtime = realtimeModule && [...realtimeModule.exports.entries()];
    return {
      schemaVersion: 2,
      baselineSnapshot: true,
      analysis:
        "TypeScript syntax; route-family reader links are candidates, not proof of entity equivalence; unknown dynamic values are explicit.",
      scope: { files: [...this.modules.keys()].toSorted() },
      mutations: this.mutations.toSorted((a, b) => compareCodeUnit(a.id, b.id)),
      readers: this.readers.toSorted((a, b) => compareCodeUnit(a.id, b.id)),
      realtimePolicy: realtime
        ? {
            file: realtimeModule.file,
            resourceToScopes:
              realtimeModule.exports
                .get("RESOURCE_REALTIME_QUERY_POLICY")
                ?.getText() ?? null,
            scopeToKeys:
              realtimeModule.exports
                .get("getResourceQueryScopeKeys")
                ?.getText() ?? null,
            note: "Existing realtime owner; policy metadata does not prove an API route emits an event or shares a resource type.",
          }
        : null,
    };
  };
}
/** Syntax analysis deliberately reports unknowns; it never executes application modules. */
export const inspectMutationQuerySources = (
  inputs: readonly SourceInput[],
  packageExports: ReadonlyMap<string, string> = new Map(),
) => new CensusAnalyzer(inputs, packageExports).analyze();

export type MutationQueryCensus = ReturnType<
  typeof inspectMutationQuerySources
>;

export const generateMutationQueryCensus = (root: string) => {
  const packageDirectories = [
    ...new Bun.Glob("packages/*/package.json").scanSync({ cwd: root }),
  ].toSorted();
  const manifests = new Map(
    packageDirectories.map((file) => {
      const manifest = JSON.parse(readFileSync(path.join(root, file), "utf-8"));
      return [manifest.name, { directory: path.posix.dirname(file), manifest }];
    }),
  );
  const packages = new Set<string>();
  const packageExports = new Map<string, string>();
  for (const [name, { directory, manifest }] of manifests) {
    if (!manifest.exports || typeof manifest.exports !== "object") {
      continue;
    }
    for (const [specifier, target] of Object.entries(manifest.exports)) {
      if (
        typeof target !== "string" ||
        !target.startsWith("./src/") ||
        !specifier.startsWith(".")
      ) {
        continue;
      }
      packageExports.set(
        specifier === "." ? name : `${String(name)}/${specifier.slice(2)}`,
        path.posix.join(directory, target),
      );
    }
  }
  const visitDependencies = (manifest: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }) => {
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    }).toSorted()) {
      const dependency = manifests.get(name);
      if (!dependency || packages.has(dependency.directory)) {
        continue;
      }
      packages.add(dependency.directory);
      visitDependencies(dependency.manifest);
    }
  };
  visitDependencies(
    JSON.parse(readFileSync(path.join(root, "apps/web/package.json"), "utf-8")),
  );
  const files: string[] = [];
  for (const directory of ["apps/web", ...[...packages].toSorted()]) {
    for (const file of new Bun.Glob(
      `${directory}/src/**/*.{ts,tsx,js,jsx,mts,cts}`,
    ).scanSync({ cwd: root })) {
      if (isMutationQueryCensusSource(file)) {
        files.push(file);
      }
    }
  }
  const census = inspectMutationQuerySources(
    files.toSorted().map((file) => ({
      file,
      text: readFileSync(path.join(root, file), "utf-8"),
    })),
    packageExports,
  );
  return {
    ...census,
    scope: {
      ...census.scope,
      packages: [...packages].toSorted(),
      selection:
        "All production src files in web and its transitive workspace dependencies (including dev dependencies); conservative package-level superset.",
    },
  };
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args.at(0) !== "--write")) {
    process.stderr.write(
      "Usage: bun scripts/mutation-query-census.ts [--write]\n",
    );
    process.exit(1);
  }
  const root = path.resolve(import.meta.dir, "..");
  const census = generateMutationQueryCensus(root);
  const json = `${JSON.stringify(census, null, 2)}\n`;
  if (args.at(0) === "--write") {
    writeFileSync(path.join(root, "scripts/mutation-query-census.json"), json);
  } else {
    process.stdout.write(json);
  }
}
