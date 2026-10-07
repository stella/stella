// Pure scanner behind `apps/api/scripts/deployment-feature-guard.ts`.
//
// Input is plain `{ file, source }` records (repo-relative paths) plus the
// committed capability catalog's `feature` tags; output is a list of findings.
// No filesystem access, no module imports of the scanned code: the guard script
// collects the sources, and the unit tests feed synthetic or mutated ones.
//
// Three questions, each answered by enumeration rather than by a hand list:
//
//   1. Flags. The declared deployment flags are the keys of the owner's total
//      local-development map (`LOCAL_DEV_ACCESS_BY_FLAG` in
//      `apps/api/src/lib/deployment-feature.ts`). A reader is an owner call
//      with a literal flag, a `feature: "FEATURE_X"` tag on an agent-facing
//      surface, a catalog entry's `feature`, or a sanctioned raw `env.FEATURE_X`
//      read. A declared flag with no reader is dead; a read of an undeclared
//      flag is an error.
//   2. Raw reads. A `FEATURE_*` key read off `process.env`, `Bun.env` or
//      `import.meta.env` skips both the env schema and the owner.
//   3. Routes. Every Elysia instance in the route tree is walked in chain order
//      (gates apply to routes registered after them, and to child instances
//      mounted after them). A capability whose catalog entry carries a
//      deployment flag must be mounted behind a gate that reads that flag, on
//      every mount; a flag read inside the handler is not a gate. Every gate
//      must read declared flags. Every route file is either gated, mounts a
//      flagged capability, or is declared always-on; the rest are
//      unclassified.

import { panic } from "better-result";
import ts from "typescript";

import { compareCodeUnit } from "@stll/collation";

import { deriveCapabilityId, HANDLERS_ROOT_PREFIX } from "./capability-catalog";

export type SourceRecord = { file: string; source: string };

export const DEPLOYMENT_FEATURE_OWNER_FILE =
  "apps/api/src/lib/deployment-feature.ts";
const OWNER_MAP_NAME = "LOCAL_DEV_ACCESS_BY_FLAG";
const OWNER_CALL = "isDeploymentFeatureEnabled";
const GATE_PLUGIN = "deploymentFeatureGate";
const FEATURE_PREFIX = "FEATURE_";
const FEATURE_TAG_PROPERTIES = new Set(["feature", "deploymentFeature"]);
const API_ALIAS_PREFIX = "@/api/";
const API_SRC_PREFIX = "apps/api/src/";
export const SERVER_ROOT_FILE = "apps/api/src/server.ts";

const HOOK_METHODS: ReadonlySet<string> = new Set([
  "onBeforeHandle",
  "onRequest",
  "onTransform",
]);
const HTTP_METHODS: ReadonlySet<string> = new Set([
  "all",
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "ws",
]);

type FlagReadForm =
  /** `isDeploymentFeatureEnabled("FEATURE_X")`. */
  | "owner-call"
  /** `feature: "FEATURE_X"` on a tool, resource or capability declaration. */
  | "feature-tag"
  /** The committed capability catalog's `feature` field. */
  | "catalog-feature"
  /** `env.FEATURE_X` on the API env object (lint-sanctioned files only). */
  | "env-read"
  /** A `FEATURE_*` key read off `process.env`, `Bun.env` or `import.meta.env`. */
  | "process-env-read";

type FlagRead = { file: string; flag: string; form: FlagReadForm };

export type Finding =
  | { kind: "dead-flag"; flag: string }
  | { kind: "undeclared-read"; flag: string; file: string; form: FlagReadForm }
  | { kind: "process-env-read"; flag: string; file: string }
  | { kind: "undeclared-gate-flag"; flag: string; file: string }
  | {
      kind: "flagged-capability";
      capability: string;
      flag: string;
      routeFile: string;
    }
  | { kind: "route-file"; routeFile: string }
  | { kind: "unattributed-mount"; routeFile: string; handler: string };

/** Stable key for a finding: no line numbers, so edits elsewhere never churn it. */
export const findingKey = (finding: Finding): string => {
  switch (finding.kind) {
    case "dead-flag":
      return `dead-flag:${finding.flag}`;
    case "undeclared-read":
      return `undeclared-read:${finding.flag}:${finding.file}`;
    case "process-env-read":
      return `process-env-read:${finding.flag}:${finding.file}`;
    case "undeclared-gate-flag":
      return `undeclared-gate-flag:${finding.flag}:${finding.file}`;
    case "flagged-capability":
      return `flagged-capability:${finding.capability}@${finding.routeFile}`;
    case "route-file":
      return `route-file:${finding.routeFile}`;
    case "unattributed-mount":
      return `unattributed-mount:${finding.handler}@${finding.routeFile}`;
    default:
      finding satisfies never;
      return panic("deployment-feature-scan: unknown finding kind");
  }
};

/**
 * Findings that may sit in the shrink-only baseline. The rest (an undeclared
 * flag, a raw process-env read, a mount the walker could not attribute) are
 * always errors: there is no legitimate existing instance to grandfather.
 */
export const BASELINABLE_KINDS: ReadonlySet<Finding["kind"]> = new Set([
  "dead-flag",
  "flagged-capability",
  "route-file",
]);

// --- AST helpers -------------------------------------------------------------

type ParsedSource = {
  sourceFile: ts.SourceFile;
  context?: FileContext;
  flagReads?: FlagRead[];
};

/**
 * Parsed sources by file, then by exact text. Scans of edited copies of one
 * tree (the self-test) share a cache, so only the edited files parse again;
 * an edit is a different text and never reuses the original's syntax tree.
 */
export type ParseCache = Map<string, Map<string, ParsedSource>>;

export const createParseCache = (): ParseCache => new Map();

const parsedSource = (
  cache: ParseCache,
  { file, source }: SourceRecord,
): ParsedSource => {
  const byText = cache.get(file) ?? new Map<string, ParsedSource>();
  cache.set(file, byText);
  const cached = byText.get(source);
  if (cached !== undefined) {
    return cached;
  }
  const parsed: ParsedSource = {
    sourceFile: ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  };
  byText.set(source, parsed);
  return parsed;
};

const parse = (cache: ParseCache, record: SourceRecord): ts.SourceFile =>
  parsedSource(cache, record).sourceFile;

const unwrap = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const literalText = (node: ts.Node | undefined): string | undefined =>
  node !== undefined &&
  (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;

const featureName = (name: string | undefined): string | undefined =>
  name?.startsWith(FEATURE_PREFIX) === true ? name : undefined;

const propertyNameText = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;

/** `process.env`, `globalThis.process.env`, `Bun.env`, `import.meta.env`. */
const isProcessEnvObject = (node: ts.Expression): boolean => {
  const target = unwrap(node);
  if (!ts.isPropertyAccessExpression(target) || target.name.text !== "env") {
    return false;
  }
  const owner = unwrap(target.expression);
  if (ts.isIdentifier(owner)) {
    return owner.text === "process" || owner.text === "Bun";
  }
  if (ts.isMetaProperty(owner)) {
    return owner.keywordToken === ts.SyntaxKind.ImportKeyword;
  }
  return (
    ts.isPropertyAccessExpression(owner) &&
    ts.isIdentifier(owner.expression) &&
    owner.expression.text === "globalThis" &&
    (owner.name.text === "process" || owner.name.text === "Bun")
  );
};

const isApiEnvObject = (node: ts.Expression): boolean => {
  const target = unwrap(node);
  return ts.isIdentifier(target) && target.text === "env";
};

const memberKey = (
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined =>
  ts.isPropertyAccessExpression(node)
    ? node.name.text
    : literalText(node.argumentExpression);

const isOwnerCall = (node: ts.CallExpression): boolean => {
  const callee = unwrap(node.expression);
  return ts.isIdentifier(callee) && callee.text === OWNER_CALL;
};

/** The read form of a member or destructuring on `object`, if it is an env object. */
const envReadForm = (object: ts.Expression): FlagReadForm | undefined => {
  if (isProcessEnvObject(object)) {
    return "process-env-read";
  }
  return isApiEnvObject(object) ? "env-read" : undefined;
};

/** Every literal deployment-flag read under `root`, in source order. */
const collectFlagReads = (file: string, root: ts.Node): FlagRead[] => {
  const reads: FlagRead[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isOwnerCall(node)) {
      const flag = featureName(literalText(node.arguments[0]));
      if (flag !== undefined) {
        reads.push({ file, flag, form: "owner-call" });
      }
    } else if (
      ts.isPropertyAssignment(node) &&
      FEATURE_TAG_PROPERTIES.has(propertyNameText(node.name) ?? "")
    ) {
      const flag = featureName(literalText(unwrap(node.initializer)));
      if (flag !== undefined) {
        reads.push({ file, flag, form: "feature-tag" });
      }
    } else if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const flag = featureName(memberKey(node));
      const form = envReadForm(node.expression);
      if (flag !== undefined && form !== undefined) {
        reads.push({ file, flag, form });
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isObjectBindingPattern(node.name)
    ) {
      const form = envReadForm(node.initializer);
      if (form !== undefined) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          const flag = featureName(
            ts.isIdentifier(key) || ts.isStringLiteral(key)
              ? key.text
              : undefined,
          );
          if (flag !== undefined) {
            reads.push({ file, flag, form });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return reads;
};

// --- Declared flags ------------------------------------------------------------

/**
 * Keys of the owner's total local-development map. The map `satisfies
 * Record<DeploymentFeatureFlag, ...>`, so typecheck pins it to the env schema's
 * `FEATURE_*` keys exactly; reading it here reads the declared set.
 */
const declaredFlagsFromOwner = (
  cache: ParseCache,
  ownerSource: string,
): string[] => {
  const sourceFile = parse(cache, {
    file: DEPLOYMENT_FEATURE_OWNER_FILE,
    source: ownerSource,
  });
  const flags: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === OWNER_MAP_NAME &&
      node.initializer !== undefined
    ) {
      const literal = unwrap(node.initializer);
      if (ts.isObjectLiteralExpression(literal)) {
        for (const property of literal.properties) {
          const name =
            property.name === undefined
              ? undefined
              : propertyNameText(property.name);
          const flag = featureName(name);
          if (flag !== undefined) {
            flags.push(flag);
          }
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return flags.toSorted();
};

// --- Route tree ----------------------------------------------------------------

type ImportBinding = { importPath: string; exportName: string | undefined };

type ModuleRef = { file: string; exportName: string | undefined };

type ChainItem =
  | { kind: "gate"; flags: string[] }
  | {
      kind: "mount";
      handler: ts.Expression;
      handlerText: string;
      routeFlags: string[];
    }
  | { kind: "child"; target: InstanceKey }
  | { kind: "group"; items: ChainItem[] };

type InstanceKey = string;

type Instance = {
  key: InstanceKey;
  file: string;
  /** Instance this chain continues (`const b = a.get(...)`), if any. */
  base: InstanceKey | undefined;
  /**
   * Source position of this chain when its base lives in the same file: only
   * base statements before it had run when this chain was registered.
   */
  basePosition: number | undefined;
  /** The initializer chain's items. */
  items: ChainItem[];
  /** Module-level statements that keep chaining onto this instance. */
  continued: { position: number; items: ChainItem[] }[];
};

/**
 * An instance's items in registration order: its initializer chain, then each
 * continuation statement before `before` (all of them when undefined).
 */
const orderedItems = (
  instance: Instance,
  before: number | undefined,
): ChainItem[] => [
  ...instance.items,
  ...instance.continued
    .filter(({ position }) => before === undefined || position < before)
    .flatMap(({ items }) => items),
];

type FileContext = {
  file: string;
  imports: Map<string, ImportBinding>;
  /** Local const name -> initializer, for helper and instance resolution. */
  locals: Map<string, ts.Expression>;
  /** Exported name -> local name. */
  exports: Map<string, string>;
  /** Module-level expression statements, in source order. */
  statements: ts.Expression[];
};

const instanceKey = (file: string, local: string): InstanceKey =>
  `${file}#${local}`;

const resolveImportPath = (
  fromFile: string,
  importPath: string,
  knownFiles: ReadonlySet<string>,
): string | undefined => {
  let base: string;
  if (importPath.startsWith(API_ALIAS_PREFIX)) {
    base = `${API_SRC_PREFIX}${importPath.slice(API_ALIAS_PREFIX.length)}`;
  } else if (importPath.startsWith(".")) {
    const segments = fromFile.split("/").slice(0, -1);
    for (const part of importPath.split("/")) {
      if (part === "..") {
        segments.pop();
      } else if (part !== ".") {
        segments.push(part);
      }
    }
    base = segments.join("/");
  } else {
    return undefined;
  }
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((candidate) =>
    knownFiles.has(candidate),
  );
};

const fileContext = (file: string, sourceFile: ts.SourceFile): FileContext => {
  const imports = new Map<string, ImportBinding>();
  const locals = new Map<string, ts.Expression>();
  const exports = new Map<string, string>();
  const statements: ts.Expression[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExpressionStatement(statement)) {
      statements.push(statement.expression);
    } else if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.importClause !== undefined &&
      statement.importClause.phaseModifier !== ts.SyntaxKind.TypeKeyword
    ) {
      const importPath = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause.name !== undefined) {
        imports.set(clause.name.text, { importPath, exportName: undefined });
      }
      if (
        clause.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings)
      ) {
        for (const element of clause.namedBindings.elements) {
          imports.set(element.name.text, {
            importPath,
            exportName: (element.propertyName ?? element.name).text,
          });
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      const exported =
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        ) === true;
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer !== undefined
        ) {
          locals.set(declaration.name.text, declaration.initializer);
          if (exported) {
            exports.set(declaration.name.text, declaration.name.text);
          }
        }
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      locals.set("default", statement.expression);
      exports.set("default", "default");
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        exports.set(
          element.name.text,
          (element.propertyName ?? element.name).text,
        );
      }
    }
  }
  return { file, imports, locals, exports, statements };
};

const parseWithContext = (
  cache: ParseCache,
  record: SourceRecord,
): { sourceFile: ts.SourceFile; context: FileContext } => {
  const parsed = parsedSource(cache, record);
  parsed.context ??= fileContext(record.file, parsed.sourceFile);
  return { sourceFile: parsed.sourceFile, context: parsed.context };
};

/** `a.b().c()` -> root `a` plus the calls in application order. */
const flattenChain = (
  expression: ts.Expression,
): { root: ts.Expression; calls: ts.CallExpression[] } => {
  const calls: ts.CallExpression[] = [];
  let current = unwrap(expression);
  while (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression)
  ) {
    calls.unshift(current);
    current = unwrap(current.expression.expression);
  }
  return { root: current, calls };
};

const callbackBody = (
  node: ts.Expression | undefined,
): ts.Expression | undefined => {
  if (node === undefined) {
    return undefined;
  }
  const target = unwrap(node);
  if (!ts.isArrowFunction(target) && !ts.isFunctionExpression(target)) {
    return undefined;
  }
  if (!ts.isBlock(target.body)) {
    return target.body;
  }
  for (const statement of target.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression !== undefined) {
      return statement.expression;
    }
  }
  return undefined;
};

const isNewElysia = (node: ts.Expression): boolean =>
  ts.isNewExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === "Elysia";

type ScanEnvironment = {
  cache: ParseCache;
  contexts: Map<string, FileContext>;
  sourceFiles: Map<string, ts.SourceFile>;
  /** Every repo-relative file path the import resolver may land on. */
  allFiles: ReadonlySet<string>;
  readSource: (file: string) => string | undefined;
};

/** The source of the exported const `name` in `file`, parsed, if any. */
const exportedInitializer = (
  environment: ScanEnvironment,
  file: string,
  name: string,
): { file: string; node: ts.Expression } | undefined => {
  let context = environment.contexts.get(file);
  if (context === undefined) {
    const source = environment.readSource(file);
    if (source === undefined) {
      return undefined;
    }
    const parsed = parseWithContext(environment.cache, { file, source });
    context = parsed.context;
    environment.contexts.set(file, context);
    environment.sourceFiles.set(file, parsed.sourceFile);
  }
  const local = context.exports.get(name);
  const node = local === undefined ? undefined : context.locals.get(local);
  return node === undefined ? undefined : { file, node };
};

/**
 * The declaration an identifier names: a local const in `context`, or an
 * exported const of a module it imports (`@/api/...` or relative).
 */
const resolveBinding = (
  environment: ScanEnvironment,
  context: FileContext,
  name: string,
): { file: string; node: ts.Expression; local: string } | undefined => {
  const local = context.locals.get(name);
  if (local !== undefined) {
    return { file: context.file, node: local, local: name };
  }
  const binding = context.imports.get(name);
  if (binding === undefined) {
    return undefined;
  }
  const file = resolveImportPath(
    context.file,
    binding.importPath,
    environment.allFiles,
  );
  if (file === undefined) {
    return undefined;
  }
  const exportName = binding.exportName ?? "default";
  const found = exportedInitializer(environment, file, exportName);
  if (found === undefined) {
    return undefined;
  }
  const targetContext = environment.contexts.get(file);
  return {
    ...found,
    local: targetContext?.exports.get(exportName) ?? exportName,
  };
};

/**
 * The instance an expression names: an identifier bound to an Elysia chain, or
 * a call of a factory whose body returns one (`createMcpRoute(...)`).
 */
const resolveInstanceRef = (
  environment: ScanEnvironment,
  context: FileContext,
  expression: ts.Expression,
): { context: FileContext; local: string; node: ts.Expression } | undefined => {
  const target = unwrap(expression);
  const callee = ts.isCallExpression(target)
    ? unwrap(target.expression)
    : target;
  if (!ts.isIdentifier(callee)) {
    return undefined;
  }
  const resolved = resolveBinding(environment, context, callee.text);
  const resolvedContext =
    resolved === undefined
      ? undefined
      : environment.contexts.get(resolved.file);
  if (resolved === undefined || resolvedContext === undefined) {
    return undefined;
  }
  const isFactory = callbackBody(resolved.node) !== undefined;
  // A call names an instance only through a factory; a bare identifier only
  // through a chain.
  if (ts.isCallExpression(target) !== isFactory) {
    return undefined;
  }
  return isElysiaChain(environment, resolvedContext, resolved.node)
    ? { context: resolvedContext, local: resolved.local, node: resolved.node }
    : undefined;
};

const MAX_INSTANCE_DEPTH = 8;

/** Whether an expression is (a chain rooted in, or a factory returning) `new Elysia(...)`. */
function isElysiaChain(
  environment: ScanEnvironment,
  context: FileContext,
  expression: ts.Expression,
  depth = 0,
): boolean {
  if (depth > MAX_INSTANCE_DEPTH) {
    return false;
  }
  const body = callbackBody(expression);
  if (body !== undefined) {
    return isElysiaChain(environment, context, body, depth + 1);
  }
  const { root } = flattenChain(expression);
  if (isNewElysia(root)) {
    return true;
  }
  const target = unwrap(root);
  const callee = ts.isCallExpression(target)
    ? unwrap(target.expression)
    : target;
  if (!ts.isIdentifier(callee)) {
    return false;
  }
  const resolved = resolveBinding(environment, context, callee.text);
  const resolvedContext =
    resolved === undefined
      ? undefined
      : environment.contexts.get(resolved.file);
  return (
    resolved !== undefined &&
    resolvedContext !== undefined &&
    isElysiaChain(environment, resolvedContext, resolved.node, depth + 1)
  );
}

/** Flags a gate predicate or hook reads, following one helper indirection. */
const gateFlags = (
  environment: ScanEnvironment,
  context: FileContext,
  node: ts.Node,
): string[] => {
  const flags = collectFlagReads(context.file, node)
    .filter(({ form }) => form !== "feature-tag")
    .map(({ flag }) => flag);
  // `deploymentFeatureGate(isFooEnabled)` / `() => isFooEnabled()`: follow the
  // helper to its body.
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) {
      const resolved = resolveBinding(environment, context, child.text);
      if (
        resolved !== undefined &&
        (ts.isArrowFunction(resolved.node) ||
          ts.isFunctionExpression(resolved.node))
      ) {
        for (const read of collectFlagReads(resolved.file, resolved.node)) {
          if (read.form !== "feature-tag") {
            flags.push(read.flag);
          }
        }
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return [...new Set(flags)].toSorted();
};

const calleeName = (call: ts.CallExpression): string | undefined => {
  const callee = unwrap(call.expression);
  return ts.isIdentifier(callee) ? callee.text : undefined;
};

/** `deploymentFeatureGate(...)` call, directly or through a const binding. */
const asGatePlugin = (
  environment: ScanEnvironment,
  context: FileContext,
  node: ts.Expression,
): { context: FileContext; call: ts.CallExpression } | undefined => {
  const target = unwrap(node);
  if (ts.isCallExpression(target) && calleeName(target) === GATE_PLUGIN) {
    return { context, call: target };
  }
  if (ts.isIdentifier(target)) {
    const resolved = resolveBinding(environment, context, target.text);
    const resolvedContext =
      resolved === undefined
        ? undefined
        : environment.contexts.get(resolved.file);
    if (resolved !== undefined && resolvedContext !== undefined) {
      const inner = unwrap(resolved.node);
      if (ts.isCallExpression(inner) && calleeName(inner) === GATE_PLUGIN) {
        return { context: resolvedContext, call: inner };
      }
    }
  }
  return undefined;
};

const objectProperty = (
  node: ts.Expression | undefined,
  name: string,
): ts.Node | undefined => {
  if (node === undefined) {
    return undefined;
  }
  const target = unwrap(node);
  if (!ts.isObjectLiteralExpression(target)) {
    return undefined;
  }
  for (const property of target.properties) {
    if (
      (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) &&
      propertyNameText(property.name) === name
    ) {
      // A method `beforeHandle() {}` is its own function node.
      return ts.isPropertyAssignment(property)
        ? property.initializer
        : property;
    }
  }
  return undefined;
};

type InstanceTable = Map<InstanceKey, Instance>;

/** One chain walk: where instances land and how inline children are named. */
type Walk = {
  environment: ScanEnvironment;
  table: InstanceTable;
  context: FileContext;
  /** Inline `new Elysia()` children are keyed under the instance that mounts them. */
  inline: { owner: string; next: number };
};

const registerInstance = (
  walk: Omit<Walk, "context" | "inline">,
  context: FileContext,
  local: string,
  expression: ts.Expression,
): InstanceKey => {
  const key = instanceKey(context.file, local);
  if (walk.table.has(key)) {
    return key;
  }
  const target = unwrap(expression);
  const { root, calls } = flattenChain(callbackBody(target) ?? target);
  // Reserve the key before walking so a self-reference cannot recurse.
  const instance: Instance = {
    key,
    file: context.file,
    base: undefined,
    basePosition: undefined,
    items: [],
    continued: [],
  };
  walk.table.set(key, instance);
  if (!isNewElysia(root)) {
    const ref = resolveInstanceRef(walk.environment, context, root);
    if (ref !== undefined) {
      instance.base = registerInstance(walk, ref.context, ref.local, ref.node);
      // An imported base's module ran to completion before this one; a base
      // in the same file has only run the statements above this chain.
      instance.basePosition =
        ref.context.file === context.file ? expression.pos : undefined;
    }
  }
  const inner: Walk = { ...walk, context, inline: { owner: local, next: 0 } };
  instance.items = chainItems(inner, calls);
  // Module-level statements that keep chaining onto this instance
  // (`filesRoute.get(...)`) register their routes after its declaration.
  if (context.locals.get(local) === expression) {
    for (const statement of context.statements) {
      const continued = flattenChain(statement);
      const continuedRoot = unwrap(continued.root);
      if (ts.isIdentifier(continuedRoot) && continuedRoot.text === local) {
        instance.continued.push({
          position: statement.pos,
          items: chainItems(inner, continued.calls),
        });
      }
    }
  }
  return key;
};

const pluginMountItem = (
  walk: Walk,
  argument: ts.Expression,
): ChainItem | undefined => {
  const { environment, context } = walk;
  const gate = asGatePlugin(environment, context, argument);
  if (gate !== undefined) {
    return {
      kind: "gate",
      flags: gateFlags(environment, gate.context, gate.call),
    };
  }
  const target = unwrap(argument);
  const ref = resolveInstanceRef(environment, context, target);
  if (ref !== undefined) {
    return {
      kind: "child",
      target: registerInstance(walk, ref.context, ref.local, ref.node),
    };
  }
  if (isElysiaChain(environment, context, target)) {
    walk.inline.next += 1;
    return {
      kind: "child",
      target: registerInstance(
        walk,
        context,
        `${walk.inline.owner}<inline ${walk.inline.next}>`,
        target,
      ),
    };
  }
  return undefined;
};

const guardItem = (
  walk: Walk,
  call: ts.CallExpression,
): ChainItem | undefined => {
  const [options, scopedCallback] = call.arguments;
  const hook = objectProperty(options, "beforeHandle");
  const flags =
    hook === undefined ? [] : gateFlags(walk.environment, walk.context, hook);
  const scoped = callbackBody(scopedCallback);
  if (scoped !== undefined) {
    const gate: ChainItem[] = flags.length > 0 ? [{ kind: "gate", flags }] : [];
    return {
      kind: "group",
      items: [...gate, ...chainItems(walk, flattenChain(scoped).calls)],
    };
  }
  return flags.length > 0 ? { kind: "gate", flags } : undefined;
};

/** One chained call as an ordered item, or undefined when it adds nothing. */
const callItem = (
  walk: Walk,
  call: ts.CallExpression,
): ChainItem | undefined => {
  if (!ts.isPropertyAccessExpression(call.expression)) {
    return undefined;
  }
  const method = call.expression.name.text;
  const [first, second, third] = call.arguments;
  if (method === "use") {
    return first === undefined ? undefined : pluginMountItem(walk, first);
  }
  if (HOOK_METHODS.has(method)) {
    const flags = call.arguments.flatMap((argument) =>
      gateFlags(walk.environment, walk.context, argument),
    );
    return flags.length > 0
      ? { kind: "gate", flags: [...new Set(flags)].toSorted() }
      : undefined;
  }
  if (method === "guard") {
    return guardItem(walk, call);
  }
  if (method === "group") {
    const callback = callbackBody(third) ?? callbackBody(second);
    return callback === undefined
      ? undefined
      : {
          kind: "group",
          items: chainItems(walk, flattenChain(callback).calls),
        };
  }
  if (HTTP_METHODS.has(method) && second !== undefined) {
    const hook = objectProperty(third, "beforeHandle");
    return {
      kind: "mount",
      handler: second,
      handlerText: second.getText(),
      routeFlags:
        hook === undefined
          ? []
          : gateFlags(walk.environment, walk.context, hook),
    };
  }
  return undefined;
};

/** Walk one chain's calls into ordered items; nested instances get registered. */
function chainItems(
  walk: Walk,
  calls: readonly ts.CallExpression[],
): ChainItem[] {
  const items: ChainItem[] = [];
  for (const call of calls) {
    const item = callItem(walk, call);
    if (item !== undefined) {
      items.push(item);
    }
  }
  return items;
}

const handlerPropertyAccess = (
  node: ts.Expression | undefined,
): ts.PropertyAccessExpression | undefined => {
  if (node === undefined) {
    return undefined;
  }
  const target = unwrap(node);
  return ts.isPropertyAccessExpression(target) && target.name.text === "handler"
    ? target
    : undefined;
};

/** Every `x.handler` / `x.default.handler` passed as a route handler in a file. */
const handlerArguments = (sourceFile: ts.SourceFile): string[] => {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      HTTP_METHODS.has(node.expression.name.text)
    ) {
      const handler = node.arguments[1];
      if (
        handler !== undefined &&
        handlerPropertyAccess(handler) !== undefined
      ) {
        found.push(handler.getText());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

/** The capability module a `x.handler` / `x.default.handler` mount names. */
const mountedModule = (
  environment: ScanEnvironment,
  context: FileContext,
  handler: ts.Expression,
): ModuleRef | undefined => {
  const access = handlerPropertyAccess(handler);
  if (access === undefined) {
    return undefined;
  }
  let target = unwrap(access.expression);
  if (ts.isPropertyAccessExpression(target) && target.name.text === "default") {
    target = unwrap(target.expression);
  }
  if (!ts.isIdentifier(target)) {
    return undefined;
  }
  const binding = context.imports.get(target.text);
  if (binding !== undefined) {
    const file = resolveImportPath(
      context.file,
      binding.importPath,
      environment.allFiles,
    );
    return file === undefined
      ? undefined
      : { file, exportName: binding.exportName };
  }
  // A handler defined in the route file itself counts only when exported (the
  // catalog enumerates exported endpoints).
  return context.exports.has(target.text)
    ? { file: context.file, exportName: target.text }
    : undefined;
};

const capabilityIdFor = (ref: ModuleRef): string | undefined =>
  ref.file.startsWith(HANDLERS_ROOT_PREFIX)
    ? deriveCapabilityId({
        file: ref.file,
        exportName: ref.exportName === "default" ? undefined : ref.exportName,
      })
    : undefined;

export type ScanInput = {
  /** Owner module source (declared flags). */
  ownerSource: string;
  /** Runtime sources whose literal flag reads count as readers. */
  readerFiles: readonly SourceRecord[];
  /** Sources searched for raw process-env flag reads (product + scripts). */
  processEnvFiles: readonly SourceRecord[];
  /** Route files: every handler file that builds an Elysia instance, plus the server root. */
  routeFiles: readonly SourceRecord[];
  /** Catalog capability id -> its deployment `feature` tag. */
  catalogFeatures: ReadonlyMap<string, string | undefined>;
  /** Route files declared always-on (file -> reason). */
  alwaysOnRouteFiles: ReadonlyMap<string, string>;
  /** Reads any repo file (helpers, handler modules); undefined when absent. */
  readSource: (file: string) => string | undefined;
  /** Every repo-relative file path the import resolver may land on. */
  allFiles: ReadonlySet<string>;
};

export type ScanResult = {
  declared: string[];
  reads: FlagRead[];
  findings: Finding[];
  /** Route files walked and instances found, for the anti-vacuity check. */
  routeFileCount: number;
  instanceCount: number;
  capabilityMountCount: number;
};

// --- Flag readers -----------------------------------------------------------------

const fileFlagReads = (cache: ParseCache, record: SourceRecord): FlagRead[] => {
  const parsed = parsedSource(cache, record);
  parsed.flagReads ??= collectFlagReads(record.file, parsed.sourceFile);
  return parsed.flagReads;
};

const scanReaders = ({
  input,
  declared,
  cache,
}: {
  input: ScanInput;
  declared: ReadonlySet<string>;
  cache: ParseCache;
}): { reads: FlagRead[]; findings: Finding[] } => {
  const reads: FlagRead[] = [];
  for (const record of input.readerFiles) {
    if (
      record.file !== DEPLOYMENT_FEATURE_OWNER_FILE &&
      record.source.includes(FEATURE_PREFIX)
    ) {
      reads.push(...fileFlagReads(cache, record));
    }
  }
  for (const [capability, flag] of input.catalogFeatures) {
    if (flag !== undefined) {
      reads.push({
        file: `catalog:${capability}`,
        flag,
        form: "catalog-feature",
      });
    }
  }
  const findings: Finding[] = reads
    .filter(({ flag }) => !declared.has(flag))
    .map(({ flag, file, form }) => ({
      kind: "undeclared-read",
      flag,
      file,
      form,
    }));
  // A process-env read is a defect of its own, never a reader.
  const readFlags = new Set(
    reads
      .filter(({ form }) => form !== "process-env-read")
      .map(({ flag }) => flag),
  );
  for (const flag of declared) {
    if (!readFlags.has(flag)) {
      findings.push({ kind: "dead-flag", flag });
    }
  }
  return { reads, findings };
};

const scanProcessEnvReads = (
  input: ScanInput,
  cache: ParseCache,
): Finding[] => {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const record of [...input.processEnvFiles, ...input.readerFiles]) {
    if (!record.source.includes(FEATURE_PREFIX)) {
      continue;
    }
    for (const read of fileFlagReads(cache, record)) {
      const key = `${read.flag}:${read.file}`;
      if (read.form === "process-env-read" && !seen.has(key)) {
        seen.add(key);
        findings.push({
          kind: "process-env-read",
          flag: read.flag,
          file: read.file,
        });
      }
    }
  }
  return findings;
};

// --- Route graph ----------------------------------------------------------------------

type Mount = {
  instance: InstanceKey;
  file: string;
  handler: ts.Expression;
  handlerText: string;
  /** Gates in force at the mount within its own instance (and its base). */
  gates: ReadonlySet<string>;
};

type ParentEdge = { parent: InstanceKey; gates: ReadonlySet<string> };

type RouteGraph = {
  environment: ScanEnvironment;
  table: InstanceTable;
  mounts: Mount[];
  parentEdges: Map<InstanceKey, ParentEdge[]>;
  /** Every flag a gate reads, per route file. */
  gateFlagsByFile: Map<string, Set<string>>;
};

const buildEnvironment = (
  input: ScanInput,
  cache: ParseCache,
): ScanEnvironment => {
  const routeSources = new Map(
    input.routeFiles.map(({ file, source }) => [file, source]),
  );
  const environment: ScanEnvironment = {
    cache,
    contexts: new Map(),
    sourceFiles: new Map(),
    allFiles: input.allFiles,
    readSource: (file) => routeSources.get(file) ?? input.readSource(file),
  };
  for (const record of input.routeFiles) {
    const { sourceFile, context } = parseWithContext(cache, record);
    environment.sourceFiles.set(record.file, sourceFile);
    environment.contexts.set(record.file, context);
  }
  return environment;
};

const addFileFlags = (
  graph: RouteGraph,
  file: string,
  flags: Iterable<string>,
): void => {
  const fileFlags = graph.gateFlagsByFile.get(file) ?? new Set<string>();
  for (const flag of flags) {
    fileFlags.add(flag);
  }
  graph.gateFlagsByFile.set(file, fileFlags);
};

/**
 * Walk an instance's items in order from the gates in force at `start`;
 * returns the gates in force after the last item. With `record`, mounts and
 * child edges are collected into the graph.
 */
const walkItems = ({
  graph,
  instance,
  items,
  start,
  record,
}: {
  graph: RouteGraph;
  instance: Instance;
  items: readonly ChainItem[];
  start: ReadonlySet<string>;
  record: boolean;
}): Set<string> => {
  const gates = new Set(start);
  for (const item of items) {
    switch (item.kind) {
      case "gate":
        for (const flag of item.flags) {
          gates.add(flag);
        }
        if (record) {
          addFileFlags(graph, instance.file, item.flags);
        }
        break;
      case "mount":
        if (record) {
          addFileFlags(graph, instance.file, item.routeFlags);
          graph.mounts.push({
            instance: instance.key,
            file: instance.file,
            handler: item.handler,
            handlerText: item.handlerText,
            gates: new Set([...gates, ...item.routeFlags]),
          });
        }
        break;
      case "child":
        if (record) {
          const edges = graph.parentEdges.get(item.target) ?? [];
          edges.push({ parent: instance.key, gates: new Set(gates) });
          graph.parentEdges.set(item.target, edges);
        }
        break;
      case "group":
        // A group's hooks stay inside the group.
        walkItems({ graph, instance, items: item.items, start: gates, record });
        break;
      default:
        item satisfies never;
        return panic("deployment-feature-scan: unknown chain item");
    }
  }
  return gates;
};

/** Gates in force where an instance's base chain stopped when it was derived. */
const baseGates = (
  graph: RouteGraph,
  instance: Instance,
  depth = 0,
): ReadonlySet<string> => {
  const base =
    instance.base === undefined ? undefined : graph.table.get(instance.base);
  if (base === undefined || depth > MAX_INSTANCE_DEPTH) {
    return new Set<string>();
  }
  return walkItems({
    graph,
    instance: base,
    items: orderedItems(base, instance.basePosition),
    start: baseGates(graph, base, depth + 1),
    record: false,
  });
};

const buildRouteGraph = (input: ScanInput, cache: ParseCache): RouteGraph => {
  const environment = buildEnvironment(input, cache);
  const table: InstanceTable = new Map();
  for (const record of input.routeFiles) {
    const context = environment.contexts.get(record.file);
    if (context === undefined) {
      continue;
    }
    for (const [local, expression] of context.locals) {
      if (isElysiaChain(environment, context, expression)) {
        registerInstance({ environment, table }, context, local, expression);
      }
    }
  }
  const graph: RouteGraph = {
    environment,
    table,
    mounts: [],
    parentEdges: new Map(),
    gateFlagsByFile: new Map(),
  };
  for (const instance of table.values()) {
    walkItems({
      graph,
      instance,
      items: orderedItems(instance, undefined),
      start: baseGates(graph, instance),
      record: true,
    });
  }
  return graph;
};

const intersect = (sets: readonly ReadonlySet<string>[]): Set<string> => {
  const [first, ...rest] = sets;
  const result = new Set(first);
  for (const set of rest) {
    for (const flag of result) {
      if (!set.has(flag)) {
        result.delete(flag);
      }
    }
  }
  return result;
};

/**
 * Gates an instance inherits from where it is mounted: the intersection over
 * every mount point (a gate counts for a child only if every mount has it).
 * A continuation (`const b = a.get(...)`) is mounted wherever its base is.
 */
const inheritedGates = (graph: RouteGraph) => {
  const cache = new Map<InstanceKey, Set<string>>();
  const resolve = (
    key: InstanceKey,
    visiting: Set<InstanceKey>,
  ): Set<string> => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(key)) {
      return new Set();
    }
    visiting.add(key);
    const base = graph.table.get(key)?.base;
    const edges = [
      ...(graph.parentEdges.get(key) ?? []),
      ...(base === undefined ? [] : (graph.parentEdges.get(base) ?? [])),
    ];
    const result =
      edges.length === 0
        ? new Set<string>()
        : intersect(
            edges.map(
              ({ parent, gates }) =>
                new Set([...gates, ...resolve(parent, visiting)]),
            ),
          );
    visiting.delete(key);
    cache.set(key, result);
    return result;
  };
  return (key: InstanceKey): Set<string> => resolve(key, new Set());
};

// --- Route findings ---------------------------------------------------------------------

type MountScan = {
  findings: Finding[];
  /** Route files that mount at least one flagged capability. */
  flaggedFiles: Set<string>;
  /** `file\0handler text` -> mounts walked, for the anti-vacuity check. */
  attributed: Map<string, number>;
  capabilityMountCount: number;
};

const scanMounts = (
  input: ScanInput,
  graph: RouteGraph,
  inherited: (key: InstanceKey) => Set<string>,
): MountScan => {
  const scan: MountScan = {
    findings: [],
    flaggedFiles: new Set(),
    attributed: new Map(),
    capabilityMountCount: 0,
  };
  for (const mount of graph.mounts) {
    const context = graph.environment.contexts.get(mount.file);
    if (context === undefined) {
      continue;
    }
    if (handlerPropertyAccess(mount.handler) !== undefined) {
      const key = `${mount.file}\u0000${mount.handlerText}`;
      scan.attributed.set(key, (scan.attributed.get(key) ?? 0) + 1);
    }
    const module = mountedModule(graph.environment, context, mount.handler);
    const capability =
      module === undefined ? undefined : capabilityIdFor(module);
    if (
      module === undefined ||
      capability === undefined ||
      !input.catalogFeatures.has(capability)
    ) {
      continue;
    }
    scan.capabilityMountCount += 1;
    const flag = input.catalogFeatures.get(capability);
    if (flag === undefined) {
      continue;
    }
    scan.flaggedFiles.add(mount.file);
    // Only a route gate counts: a flag read inside the handler may shape the
    // response without rejecting the request.
    if (mount.gates.has(flag) || inherited(mount.instance).has(flag)) {
      continue;
    }
    scan.findings.push({
      kind: "flagged-capability",
      capability,
      flag,
      routeFile: mount.file,
    });
  }
  return scan;
};

/** Every `x.handler` route argument in a route file must have been walked. */
const scanUnattributed = (
  input: ScanInput,
  graph: RouteGraph,
  attributed: ReadonlyMap<string, number>,
): Finding[] => {
  const findings: Finding[] = [];
  for (const record of input.routeFiles) {
    const sourceFile = graph.environment.sourceFiles.get(record.file);
    if (sourceFile === undefined) {
      continue;
    }
    const counts = new Map<string, number>();
    for (const handler of handlerArguments(sourceFile)) {
      counts.set(handler, (counts.get(handler) ?? 0) + 1);
    }
    for (const [handler, count] of counts) {
      if ((attributed.get(`${record.file}\u0000${handler}`) ?? 0) < count) {
        findings.push({
          kind: "unattributed-mount",
          routeFile: record.file,
          handler,
        });
      }
    }
  }
  return findings;
};

const scanClassification = ({
  input,
  graph,
  inherited,
  flaggedFiles,
}: {
  input: ScanInput;
  graph: RouteGraph;
  inherited: (key: InstanceKey) => Set<string>;
  flaggedFiles: ReadonlySet<string>;
}): Finding[] => {
  const instancesByFile = new Map<string, Instance[]>();
  for (const instance of graph.table.values()) {
    const list = instancesByFile.get(instance.file) ?? [];
    list.push(instance);
    instancesByFile.set(instance.file, list);
  }
  const findings: Finding[] = [];
  for (const record of input.routeFiles) {
    const instances = instancesByFile.get(record.file) ?? [];
    if (record.file === SERVER_ROOT_FILE || instances.length === 0) {
      continue;
    }
    const gated =
      (graph.gateFlagsByFile.get(record.file)?.size ?? 0) > 0 ||
      instances.some((instance) => inherited(instance.key).size > 0);
    if (
      !gated &&
      !flaggedFiles.has(record.file) &&
      !input.alwaysOnRouteFiles.has(record.file)
    ) {
      findings.push({ kind: "route-file", routeFile: record.file });
    }
  }
  return findings;
};

/**
 * `cache` is the caller's: a fresh one per tree, or one shared by scans of
 * edited copies of the same tree.
 */
export const scanDeploymentFeatures = (
  input: ScanInput,
  cache: ParseCache,
): ScanResult => {
  const declared = declaredFlagsFromOwner(cache, input.ownerSource);
  const declaredSet = new Set(declared);
  const readers = scanReaders({ input, declared: declaredSet, cache });
  const graph = buildRouteGraph(input, cache);
  const inherited = inheritedGates(graph);
  const mounts = scanMounts(input, graph, inherited);
  const undeclaredGates: Finding[] = [...graph.gateFlagsByFile].flatMap(
    ([file, flags]) =>
      [...flags]
        .filter((flag) => !declaredSet.has(flag))
        .map((flag) => ({ kind: "undeclared-gate-flag" as const, flag, file })),
  );
  const findings = [
    ...readers.findings,
    ...scanProcessEnvReads(input, cache),
    ...undeclaredGates,
    ...mounts.findings,
    ...scanUnattributed(input, graph, mounts.attributed),
    ...scanClassification({
      input,
      graph,
      inherited,
      flaggedFiles: mounts.flaggedFiles,
    }),
  ];
  const unique = new Map(
    findings.map((finding) => [findingKey(finding), finding]),
  );
  return {
    declared,
    reads: readers.reads,
    findings: [...unique.values()].toSorted((a, b) =>
      compareCodeUnit(findingKey(a), findingKey(b)),
    ),
    routeFileCount: input.routeFiles.length,
    instanceCount: graph.table.size,
    capabilityMountCount: mounts.capabilityMountCount,
  };
};
