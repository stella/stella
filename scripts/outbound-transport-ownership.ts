import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { canonicalModuleId } from "../.oxlint-plugins/module-id.ts";
import {
  OUTBOUND_PERMIT_GRANT_OWNERS,
  OUTBOUND_TRANSPORT_CLASSES,
  OUTBOUND_TRANSPORT_CENSUS,
  type OutboundTransportCensusEntry,
} from "./outbound-transport-census.ts";
import { parseSource } from "./parse-memo.ts";

const INDIRECT_TRANSPORT = "indirect:transport";
const LOCAL_MODULE_LOADER_OWNER =
  "packages/start-runtime/src/local-module-loader.ts";
export const LOCAL_MODULE_CAPABILITIES: ReadonlySet<string> = new Set([
  "local:module-import",
  "local:module-loader",
]);

const GLOBAL_ROOTS = new Set(["globalThis", "self", "window", "global", "Bun"]);
const GLOBAL_TRANSPORT_NAMES = new Set([
  "fetch",
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
]);
const NETWORK_MODULES = new Set([
  "@stll/fetch",
  "bun",
  "undici",
  "http",
  "https",
  "node:http",
  "node:https",
  "http2",
  "node:http2",
  "net",
  "node:net",
  "tls",
  "node:tls",
  "dgram",
  "node:dgram",
  "dns",
  "node:dns",
  "dns/promises",
  "node:dns/promises",
  "axios",
  "ky",
  "got",
  "node-fetch",
  "cross-fetch",
  "superagent",
  "request",
  "ws",
  "nodemailer",
  "posthog-node",
  "bullmq",
  "mailauth",
  "@smithy/fetch-http-handler",
  "@opentelemetry/exporter-logs-otlp-http",
  "@opentelemetry/exporter-trace-otlp-http",
  "@opentelemetry/exporter-metrics-otlp-http",
]);
const NETWORK_PACKAGE_PREFIXES = [
  "@aws-sdk/client-",
  "@openrouter/sdk",
  "@anthropic-ai/sdk",
  "@mistralai/mistralai",
  "@ai-sdk/",
  "@tanstack/ai-openai",
  "@tanstack/ai-openrouter",
  "@tanstack/ai-anthropic",
  "@tanstack/ai-bedrock",
  "@tanstack/ai-gemini",
  "@tanstack/ai-mistral",
  "@tanstack/ai-mcp",
  "@modelcontextprotocol/client",
  "@modelcontextprotocol/sdk/client",
  "@stll/boe",
  "@stll/infosoud",
  "@google/genai",
  "@better-auth/cimd",
  "@better-auth/oauth-provider/resource-client",
  "better-auth",
  "@stll/business-registries",
  "google-auth-library",
  "openid-client",
  "oauth4webapi",
  "openai",
  "jose",
];
const PERMIT_MODULE = "apps/api/src/lib/auth/third-party-outbound-permit";
const PERMIT_GRANT = "grantThirdPartyOutboundPermit";
const CLASSES = new Set<string>(OUTBOUND_TRANSPORT_CLASSES);

const unwrap = (expression: ts.Expression): ts.Expression => {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return unwrap(expression.expression);
  }
  return expression;
};

const memberName = (
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined => {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  const argument = unwrap(node.argumentExpression);
  if (ts.isStringLiteralLike(argument)) {
    return argument.text;
  }
  return undefined;
};

const bindingMemberName = (element: ts.BindingElement) => {
  if (element.dotDotDotToken) {
    return undefined;
  }
  const name = element.propertyName ?? element.name;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  if (!ts.isComputedPropertyName(name)) {
    return undefined;
  }
  const value = unwrap(name.expression);
  return ts.isStringLiteralLike(value) ? value.text : undefined;
};

const bindingNames = (name: ts.BindingName): string[] => {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : [],
  );
};

const isScope = (node: ts.Node): boolean =>
  ts.isSourceFile(node) ||
  ts.isBlock(node) ||
  ts.isFunctionLike(node) ||
  ts.isCatchClause(node) ||
  ts.isForStatement(node) ||
  ts.isForOfStatement(node) ||
  ts.isForInStatement(node);

const scopeOf = (node: ts.Node): ts.Node => {
  let scope = node.parent;
  while (!isScope(scope)) {
    scope = scope.parent;
  }
  return scope;
};

const dynamicLoadNames = (node: ts.CallExpression): string[] | null => {
  let expression: ts.Node = node;
  while (
    ts.isAwaitExpression(expression.parent) ||
    ts.isParenthesizedExpression(expression.parent)
  ) {
    expression = expression.parent;
  }
  const parent = expression.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    ts.isObjectBindingPattern(parent.name)
  ) {
    if (parent.name.elements.some((element) => element.dotDotDotToken)) {
      return null;
    }
    const names = parent.name.elements.map(bindingMemberName);
    return names.some((name) => name === undefined)
      ? null
      : names.filter((name) => name !== undefined);
  }
  if (
    ts.isPropertyAccessExpression(parent) ||
    ts.isElementAccessExpression(parent)
  ) {
    const name = memberName(parent);
    return name === undefined ? null : [name];
  }
  return null;
};

type OutboundTransportReferencesOptions = { file: string; text: string };
type BindingScopes = Map<ts.Node, Map<string, ts.Expression | null>>;
type ModuleRegistration = (
  specifier: string,
  names: readonly string[] | null,
) => void;

type BindNameOptions = {
  scopes: BindingScopes;
  node: ts.Node;
  name: string;
  initializer?: ts.Expression | null;
};

const bindName = ({
  scopes,
  node,
  name,
  initializer = null,
}: BindNameOptions): void => {
  const scope = scopeOf(node);
  const bindings = scopes.get(scope) ?? new Map<string, ts.Expression | null>();
  bindings.set(name, initializer);
  scopes.set(scope, bindings);
};

const collectBindings = (source: ts.SourceFile): BindingScopes => {
  const scopes: BindingScopes = new Map();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const initializer = ts.isIdentifier(node.name)
        ? (node.initializer ?? null)
        : null;
      for (const name of bindingNames(node.name)) {
        bindName({ scopes, node, name, initializer });
      }
    }
    if (ts.isParameter(node)) {
      for (const name of bindingNames(node.name)) {
        bindName({ scopes, node, name });
      }
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      bindName({ scopes, node, name: node.name.text });
    }
    if (ts.isImportClause(node) && node.name) {
      bindName({ scopes, node, name: node.name.text });
    }
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
      bindName({ scopes, node, name: node.name.text });
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  return scopes;
};

type LookupBindingOptions = {
  scopes: BindingScopes;
  node: ts.Node;
  name: string;
};

const lookupBinding = ({
  scopes,
  node,
  name,
}: LookupBindingOptions): ts.Expression | null | undefined => {
  let scope = node;
  while (true) {
    const bindings = scopes.get(scope);
    if (bindings?.has(name)) {
      return bindings.get(name);
    }
    if (ts.isSourceFile(scope)) {
      return undefined;
    }
    scope = scope.parent;
  }
};

type ReflectedGlobalMemberOptions = {
  scopes: BindingScopes;
  node: ts.Expression;
};

const reflectedGlobalMember = ({
  scopes,
  node,
}: ReflectedGlobalMemberOptions) => {
  const value = unwrap(node);
  if (!ts.isCallExpression(value)) {
    return undefined;
  }
  const callee = unwrap(value.expression);
  if (
    !(
      ts.isPropertyAccessExpression(callee) ||
      ts.isElementAccessExpression(callee)
    ) ||
    memberName(callee) !== "get"
  ) {
    return undefined;
  }
  const receiver = unwrap(callee.expression);
  if (
    !ts.isIdentifier(receiver) ||
    receiver.text !== "Reflect" ||
    lookupBinding({ scopes, node: receiver, name: receiver.text }) !== undefined
  ) {
    return undefined;
  }
  const target = value.arguments.at(0);
  if (!target) {
    return undefined;
  }
  const key = value.arguments.at(1);
  const member = key && unwrap(key);
  return {
    target,
    name: member && ts.isStringLiteralLike(member) ? member.text : undefined,
  };
};

type GlobalObjectNameOptions = {
  scopes: BindingScopes;
  node: ts.Expression;
  seen?: Set<ts.Expression>;
};

const globalObjectName = ({
  scopes,
  node,
  seen = new Set<ts.Expression>(),
}: GlobalObjectNameOptions): string | undefined => {
  const value = unwrap(node);
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  const reflected = reflectedGlobalMember({ scopes, node: value });
  if (reflected) {
    const root = globalObjectName({ scopes, node: reflected.target, seen });
    if (!root) {
      return undefined;
    }
    // An unknown reflected member may return another global root.
    if (reflected.name === undefined) {
      return root;
    }
    return GLOBAL_ROOTS.has(reflected.name) ? reflected.name : undefined;
  }
  if (
    ts.isPropertyAccessExpression(value) ||
    ts.isElementAccessExpression(value)
  ) {
    const root = globalObjectName({ scopes, node: value.expression, seen });
    const name = memberName(value);
    return root && name && GLOBAL_ROOTS.has(name) ? name : undefined;
  }
  if (!ts.isIdentifier(value)) {
    return undefined;
  }
  const initializer = lookupBinding({ scopes, node: value, name: value.text });
  if (initializer === undefined) {
    return GLOBAL_ROOTS.has(value.text) ? value.text : undefined;
  }
  if (initializer === null) {
    return undefined;
  }
  return globalObjectName({ scopes, node: initializer, seen });
};

type RegisterGlobalOptions = {
  capabilities: Set<string>;
  object: string | undefined;
  name: string | undefined;
};

const registerGlobal = ({
  capabilities,
  object,
  name,
}: RegisterGlobalOptions): void => {
  if (!object) {
    return;
  }
  if (name === undefined) {
    capabilities.add(INDIRECT_TRANSPORT);
    return;
  }
  if (
    object === "Bun" &&
    ["fetch", "S3Client", "SQL", "RedisClient", "connect"].includes(name)
  ) {
    capabilities.add(`global:Bun.${name}`);
    return;
  }
  if (GLOBAL_TRANSPORT_NAMES.has(name)) {
    capabilities.add(`global:${name}`);
  }
};

type RegisterModuleOptions = {
  capabilities: Set<string>;
  file: string;
  specifier: string;
  names: readonly string[] | null;
};

const registerModule = ({
  capabilities,
  file,
  specifier,
  names,
}: RegisterModuleOptions): void => {
  const module = canonicalModuleId(specifier, file);
  if (
    module === PERMIT_MODULE &&
    (names === null || names.includes(PERMIT_GRANT))
  ) {
    capabilities.add("permit:grant");
  }
  if (
    module === "@stll/start-runtime/local-module-loader" ||
    module === canonicalModuleId(LOCAL_MODULE_LOADER_OWNER, file)
  ) {
    capabilities.add("local:module-loader");
    return;
  }
  const bunClientNames = ["S3Client", "SQL", "RedisClient", "connect", "fetch"];
  if (
    module === "bun" &&
    names !== null &&
    !names.some((name) => bunClientNames.includes(name))
  ) {
    return;
  }
  const netUtilityNames = ["BlockList", "isIP", "isIPv4", "isIPv6"];
  if (
    (module === "net" || module === "node:net") &&
    names?.every((name) => netUtilityNames.includes(name))
  ) {
    return;
  }
  const bullmqUtilityNames = ["DelayedError", "UnrecoverableError"];
  if (
    module === "bullmq" &&
    names?.every((name) => bullmqUtilityNames.includes(name))
  ) {
    return;
  }
  if (
    module === "jose" &&
    names !== null &&
    !names.includes("createRemoteJWKSet")
  ) {
    return;
  }
  const isNetworkModule = NETWORK_MODULES.has(module);
  const isNetworkPackage = NETWORK_PACKAGE_PREFIXES.some((prefix) => {
    const packagePrefix =
      prefix.endsWith("-") || prefix.endsWith("/") ? prefix : `${prefix}/`;
    return module === prefix || module.startsWith(packagePrefix);
  });
  if (isNetworkModule || isNetworkPackage) {
    capabilities.add(`module:${module}`);
  }
};

const isInsideType = (node: ts.Node): boolean => {
  let ancestor = node.parent;
  while (!ts.isSourceFile(ancestor) && !ts.isStatement(ancestor)) {
    if (ts.isTypeNode(ancestor)) {
      return true;
    }
    ancestor = ancestor.parent;
  }
  return false;
};

const moduleNamesFromImport = (
  clause: ts.ImportClause | undefined,
): readonly string[] | null => {
  const named = clause?.namedBindings;
  if (clause?.name || !named || !ts.isNamedImports(named)) {
    return null;
  }
  return named.elements
    .filter((element) => !element.isTypeOnly)
    .map((element) => (element.propertyName ?? element.name).text);
};

const moduleNamesFromExport = (
  clause: ts.NamedExportBindings | undefined,
): readonly string[] | null => {
  if (!clause || !ts.isNamedExports(clause)) {
    return null;
  }
  return clause.elements
    .filter((element) => !element.isTypeOnly)
    .map((element) => (element.propertyName ?? element.name).text);
};

type VisitModuleLoadOptions = {
  node: ts.Node;
  scopes: BindingScopes;
  register: ModuleRegistration;
  file: string;
  capabilities: Set<string>;
};

const visitModuleLoad = ({
  node,
  scopes,
  register,
  file,
  capabilities,
}: VisitModuleLoadOptions): void => {
  if (
    ts.isImportDeclaration(node) &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    const clause = node.importClause;
    if (clause?.phaseModifier === ts.SyntaxKind.TypeKeyword) {
      return;
    }
    const names = moduleNamesFromImport(clause);
    if (names === null || names.length > 0 || clause?.name || !clause) {
      register(node.moduleSpecifier.text, names);
    }
    return;
  }
  if (
    ts.isExportDeclaration(node) &&
    !node.isTypeOnly &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    const names = moduleNamesFromExport(node.exportClause);
    if (names === null || names.length > 0) {
      register(node.moduleSpecifier.text, names);
    }
    return;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    !node.isTypeOnly &&
    ts.isExternalModuleReference(node.moduleReference)
  ) {
    const specifier = unwrap(node.moduleReference.expression);
    if (ts.isStringLiteralLike(specifier)) {
      register(specifier.text, null);
    }
    return;
  }
  if (!ts.isCallExpression(node)) {
    return;
  }
  const callee = unwrap(node.expression);
  if (
    callee.kind !== ts.SyntaxKind.ImportKeyword &&
    !(
      ts.isIdentifier(callee) &&
      callee.text === "require" &&
      lookupBinding({ scopes, node: callee, name: callee.text }) === undefined
    )
  ) {
    return;
  }
  const specifier = node.arguments.at(0);
  const value = specifier && unwrap(specifier);
  if (value && ts.isStringLiteralLike(value)) {
    register(value.text, dynamicLoadNames(node));
    return;
  }
  if (
    callee.kind === ts.SyntaxKind.ImportKeyword &&
    file === LOCAL_MODULE_LOADER_OWNER
  ) {
    capabilities.add("local:module-import");
    return;
  }
  capabilities.add(INDIRECT_TRANSPORT);
};

const isGlobalNamePosition = (node: ts.Identifier): boolean => {
  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isPropertySignature(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) {
    return true;
  }
  return ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent);
};

type VisitGlobalReferenceOptions = {
  node: ts.Node;
  scopes: BindingScopes;
  capabilities: Set<string>;
};

const visitGlobalReference = ({
  node,
  scopes,
  capabilities,
}: VisitGlobalReferenceOptions): void => {
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    registerGlobal({
      capabilities,
      object: globalObjectName({ scopes, node: node.expression }),
      name: memberName(node),
    });
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isObjectBindingPattern(node.name) &&
    node.initializer
  ) {
    for (const element of node.name.elements) {
      const member = bindingMemberName(element);
      const object = globalObjectName({ scopes, node: node.initializer });
      if (object && member !== undefined && GLOBAL_ROOTS.has(member)) {
        capabilities.add(INDIRECT_TRANSPORT);
      }
      registerGlobal({ capabilities, object, name: member });
    }
  }
  if (ts.isCallExpression(node)) {
    const reflected = reflectedGlobalMember({ scopes, node });
    if (reflected) {
      const object = globalObjectName({ scopes, node: reflected.target });
      if (object) {
        capabilities.add(INDIRECT_TRANSPORT);
        registerGlobal({ capabilities, object, name: reflected.name });
      }
    }
  }
  if (
    ts.isIdentifier(node) &&
    GLOBAL_TRANSPORT_NAMES.has(node.text) &&
    !isInsideType(node) &&
    lookupBinding({ scopes, node, name: node.text }) === undefined &&
    !isGlobalNamePosition(node)
  ) {
    capabilities.add(`global:${node.text}`);
  }
};

type VisitContext = {
  capabilities: Set<string>;
  file: string;
  scopes: BindingScopes;
};

const visitSource = (source: ts.SourceFile, context: VisitContext): void => {
  const register: ModuleRegistration = (specifier, names) => {
    registerModule({
      capabilities: context.capabilities,
      file: context.file,
      specifier,
      names,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) {
      return;
    }
    visitModuleLoad({
      node,
      scopes: context.scopes,
      register,
      file: context.file,
      capabilities: context.capabilities,
    });
    visitGlobalReference({
      node,
      scopes: context.scopes,
      capabilities: context.capabilities,
    });
    ts.forEachChild(node, visit);
  };
  visit(source);
};

/** Enumerate transport capability acquisition, including captured functions. */
export const outboundTransportReferences = ({
  file,
  text,
}: OutboundTransportReferencesOptions): string[] => {
  const source = parseSource({ fileName: file, text });
  const scopes = collectBindings(source);
  const capabilities = new Set<string>();
  visitSource(source, { capabilities, file, scopes });
  return [...capabilities].toSorted();
};

type ValidateOutboundTransportCensusOptions = {
  sources: ReadonlyMap<string, string>;
  census: readonly OutboundTransportCensusEntry[];
  grantOwners: readonly { path: string; reason: string }[];
};

export const validateOutboundTransportCensus = ({
  sources,
  census,
  grantOwners,
}: ValidateOutboundTransportCensusOptions): string[] => {
  const problems: string[] = [];
  const entries = new Map(census.map((entry) => [entry.path, entry]));
  if (entries.size !== census.length) {
    problems.push("Transport census paths must be unique");
  }
  const grantPaths = new Set(grantOwners.map(({ path: owner }) => owner));
  if (grantPaths.size !== grantOwners.length) {
    problems.push("Permit grant owner paths must be unique");
  }
  const grantsSeen = new Set<string>();
  for (const { path: owner, reason } of grantOwners) {
    if (!reason.trim() || !sources.has(owner)) {
      problems.push(`${owner}: grant owner requires its source and reason`);
    }
  }
  for (const entry of census) {
    if (!CLASSES.has(entry.class)) {
      problems.push(`${entry.path}: unknown transport class ${entry.class}`);
    }
    if (
      !entry.reason.trim() ||
      entry.path.endsWith("/") ||
      !sources.has(entry.path)
    ) {
      problems.push(`${entry.path}: stale transport entry or empty reason`);
    }
    if (
      entry.transports.length === 0 ||
      new Set(entry.transports).size !== entry.transports.length
    ) {
      problems.push(
        `${entry.path}: transport entries must be nonempty and unique`,
      );
    }
  }
  for (const [file, text] of sources) {
    if (!isOutboundProductionModule(file)) {
      problems.push(`${file}: source belongs to a production transport module`);
      continue;
    }
    const references = outboundTransportReferences({ file, text });
    if (references.includes("permit:grant")) {
      grantsSeen.add(file);
      if (!grantPaths.has(file)) {
        problems.push(
          `${file}: permit creation belongs to a listed direct boundary`,
        );
      }
    }
    if (references.includes(INDIRECT_TRANSPORT)) {
      problems.push(
        `${file}: indirect acquisition belongs to the bounded local module owner`,
      );
    }
    const transports = references.filter(
      (reference) => reference !== "permit:grant",
    );
    const declared = entries.get(file)?.transports.toSorted() ?? [];
    if (JSON.stringify(transports) !== JSON.stringify(declared)) {
      const disposition =
        transports.length === 0 && entries.has(file)
          ? "stale transport entry"
          : "transport census differs";
      problems.push(
        `${file}: ${disposition} (observed ${transports.join(", ")}; declared ${declared.join(", ")})`,
      );
    }
  }
  for (const owner of grantPaths) {
    if (!grantsSeen.has(owner)) {
      problems.push(`${owner}: stale permit grant owner`);
    }
  }
  return problems;
};

const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  ".cache",
  "dist",
  "tests",
  "e2e",
  "__fixtures__",
  "contracts",
]);

export const isApiProductionModule = (
  file: string,
): file is OutboundTransportCensusEntry["path"] =>
  file.startsWith("apps/api/") &&
  /\.[cm]?[jt]sx?$/u.test(file) &&
  !/\.(?:test|type-test|spec|d)\.[cm]?[jt]sx?$/u.test(file) &&
  !file
    .split("/")
    .some(
      (segment) => EXCLUDED_DIRECTORIES.has(segment) || segment.startsWith("."),
    );

const ADDITIONAL_EXCLUDED_DIRECTORIES = new Set([
  ...EXCLUDED_DIRECTORIES,
  "test",
  "__tests__",
  "fixtures",
  "scripts",
]);

export const isOutboundProductionModule = (
  file: string,
): file is OutboundTransportCensusEntry["path"] =>
  isApiProductionModule(file) ||
  (/^(?:apps\/(?:collab|web)|packages\/[^/]+)\/src\//u.test(file) &&
    /\.[cm]?[jt]sx?$/u.test(file) &&
    !/\.(?:test|type-test|spec|d)\.[cm]?[jt]sx?$/u.test(file) &&
    !file
      .split("/")
      .slice(3)
      .some(
        (segment) =>
          ADDITIONAL_EXCLUDED_DIRECTORIES.has(segment) ||
          segment.startsWith("."),
      ));

/** Preserve the API inventory and include the other production source roots. */
export const readOutboundProductionSources = (
  repoRoot: string,
): Map<string, string> => {
  const sources = new Map<string, string>();
  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(repoRoot, relative), {
      withFileTypes: true,
    })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (
          !(
            file.startsWith("apps/api/")
              ? EXCLUDED_DIRECTORIES
              : ADDITIONAL_EXCLUDED_DIRECTORIES
          ).has(entry.name) &&
          !entry.name.startsWith(".")
        ) {
          walk(file);
        }
        continue;
      }
      if (isOutboundProductionModule(file)) {
        sources.set(file, readFileSync(path.join(repoRoot, file), "utf-8"));
      }
    }
  };
  const roots = ["apps/api", "apps/collab/src", "apps/web/src"];
  const packagesRoot = path.join(repoRoot, "packages");
  if (existsSync(packagesRoot)) {
    for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        roots.push(`packages/${entry.name}/src`);
      }
    }
  }
  for (const root of roots) {
    if (existsSync(path.join(repoRoot, root))) {
      walk(root);
    }
  }
  return sources;
};

/** The API's own sources: the scope the third-party permit guards read. */
export const readApiProductionSources = (
  repoRoot: string,
): Map<string, string> =>
  new Map(
    [...readOutboundProductionSources(repoRoot)].filter(([file]) =>
      file.startsWith("apps/api/"),
    ),
  );

/** Local transport module identities must resolve to an inventoried source. */
export const validateOutboundTransportModulePaths = (
  sources: ReadonlyMap<string, string>,
  modules: Iterable<string> = NETWORK_MODULES,
): string[] => {
  const sourceModules = new Set(
    [...sources.keys()].map((file) => canonicalModuleId(file, file)),
  );
  const problems: string[] = [];
  for (const module of modules) {
    if (
      /^(?:apps|packages)\//u.test(module) &&
      !sourceModules.has(canonicalModuleId(module, module))
    ) {
      problems.push(`${module}: transport owner path does not exist in scope`);
    }
  }
  return problems;
};

if (import.meta.main) {
  if (process.argv.length !== 3 || process.argv.at(2) !== "--check") {
    console.error("Usage: bun scripts/outbound-transport-ownership.ts --check");
    process.exit(1);
  }
  const repoRoot = path.resolve(import.meta.dir, "..");
  const sources = readOutboundProductionSources(repoRoot);
  const problems = validateOutboundTransportModulePaths(sources);
  problems.push(
    ...validateOutboundTransportCensus({
      sources,
      census: OUTBOUND_TRANSPORT_CENSUS,
      grantOwners: OUTBOUND_PERMIT_GRANT_OWNERS,
    }),
  );
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(
      `Outbound transport ownership: ${OUTBOUND_TRANSPORT_CENSUS.length} classified owners`,
    );
  }
}
