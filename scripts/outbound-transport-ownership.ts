import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { canonicalModuleId } from "../.oxlint-plugins/module-id.ts";
import {
  type Expression,
  type IdentifierName,
  type ImportDeclaration,
  type MemberExpression,
  type ModuleExportName,
  type Node,
  type ParsedSource,
  type PrivateIdentifier,
  walk as walkSyntax,
} from "../packages/scripts/src/syntax-tree.ts";
import {
  OUTBOUND_PERMIT_GRANT_OWNERS,
  OUTBOUND_TRANSPORT_CENSUS,
  OUTBOUND_TRANSPORT_CLASSES,
  type OutboundTransportCensusEntry,
} from "./outbound-transport-census.ts";
import { parseSyntax } from "./parse-memo.ts";

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
// These exact Better Auth primitives perform in-process API, cookie, and adapter work.
const LOCAL_BETTER_AUTH_MODULES = new Set([
  "better-auth/api",
  "better-auth/cookies",
  "better-auth/adapters/drizzle",
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

// oxc wraps an optional chain (`a?.b`) as a whole, where the compiler API
// reads the chain's outermost member or call directly.
const unwrap = (node: Node): Node => {
  if (
    node.type === "ParenthesizedExpression" ||
    node.type === "ChainExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    return unwrap(node.expression);
  }
  return node;
};

// A string literal or a template without substitutions.
const literalText = (node: Node): string | undefined => {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.at(0)?.value.cooked ?? undefined;
  }
  return undefined;
};

const exportName = (node: ModuleExportName) =>
  node.type === "Identifier" ? node.name : node.value;

const identifierText = (node: IdentifierName | PrivateIdentifier) =>
  node.type === "PrivateIdentifier" ? `#${node.name}` : node.name;

const memberName = (node: MemberExpression): string | undefined =>
  node.computed
    ? literalText(unwrap(node.property))
    : identifierText(node.property);

// The member a destructuring entry names: `{ fetch }`, `{ "fetch": f }` and
// `{ ["fetch"]: f }` alike; a rest entry or a dynamic key names none.
const destructuredMemberName = (element: Node) => {
  if (element.type !== "Property") {
    return undefined;
  }
  const { key } = element;
  if (element.computed) {
    return literalText(unwrap(key));
  }
  if (key.type === "Identifier") {
    return key.name;
  }
  return key.type === "Literal" && typeof key.value === "string"
    ? key.value
    : undefined;
};

const bindingNames = (pattern: Node): string[] => {
  if (pattern.type === "Identifier") {
    return [pattern.name];
  }
  if (pattern.type === "AssignmentPattern") {
    return bindingNames(pattern.left);
  }
  if (pattern.type === "RestElement") {
    return bindingNames(pattern.argument);
  }
  if (pattern.type === "TSParameterProperty") {
    return bindingNames(pattern.parameter);
  }
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((element) =>
      bindingNames(element.type === "Property" ? element.value : element),
    );
  }
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap((element) =>
      element === null ? [] : bindingNames(element),
    );
  }
  return [];
};

// The parameters of a function or signature; undefined for any other node.
const parametersOf = (node: Node): readonly Node[] | undefined => {
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "TSDeclareFunction" ||
    node.type === "TSEmptyBodyFunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "TSFunctionType" ||
    node.type === "TSConstructorType" ||
    node.type === "TSMethodSignature" ||
    node.type === "TSCallSignatureDeclaration" ||
    node.type === "TSConstructSignatureDeclaration"
  ) {
    return node.params;
  }
  return node.type === "TSIndexSignature" ? node.parameters : undefined;
};

const isScope = (node: Node): boolean =>
  node.type === "Program" ||
  node.type === "BlockStatement" ||
  node.type === "StaticBlock" ||
  parametersOf(node) !== undefined ||
  node.type === "CatchClause" ||
  node.type === "ForStatement" ||
  node.type === "ForOfStatement" ||
  node.type === "ForInStatement";

const scopeOf = (scopes: BindingScopes, node: Node): Node => {
  let scope = scopes.parents.get(node);
  while (scope !== undefined && !isScope(scope)) {
    scope = scopes.parents.get(scope);
  }
  return scope ?? node;
};

const dynamicLoadNames = (
  scopes: BindingScopes,
  node: Node,
): string[] | null => {
  let expression = node;
  let parent = scopes.parents.get(expression);
  while (
    parent?.type === "AwaitExpression" ||
    parent?.type === "ParenthesizedExpression" ||
    parent?.type === "ChainExpression"
  ) {
    expression = parent;
    parent = scopes.parents.get(expression);
  }
  if (
    parent?.type === "VariableDeclarator" &&
    parent.id.type === "ObjectPattern"
  ) {
    if (
      parent.id.properties.some((element) => element.type === "RestElement")
    ) {
      return null;
    }
    const names = parent.id.properties.map(destructuredMemberName);
    return names.some((name) => name === undefined)
      ? null
      : names.filter((name) => name !== undefined);
  }
  if (parent?.type === "MemberExpression") {
    const name = memberName(parent);
    return name === undefined ? null : [name];
  }
  return null;
};

type OutboundTransportReferencesOptions = { file: string; text: string };
type BindingScopes = {
  // oxc nodes carry no parent links.
  readonly parents: ReadonlyMap<Node, Node>;
  readonly bindings: Map<Node, Map<string, Expression | null>>;
};
type ModuleRegistration = (
  specifier: string,
  names: readonly string[] | null,
) => void;

type BindNameOptions = {
  scopes: BindingScopes;
  node: Node;
  name: string;
  initializer?: Expression | null;
  own?: boolean;
};

// Binds `name` in the scope around `node`, or in `node` itself when it is the
// scope (a function for its parameters, a catch clause for its binding).
const bindName = ({
  scopes,
  node,
  name,
  initializer = null,
  own = false,
}: BindNameOptions): void => {
  const scope = own ? node : scopeOf(scopes, node);
  const bindings =
    scopes.bindings.get(scope) ?? new Map<string, Expression | null>();
  bindings.set(name, initializer);
  scopes.bindings.set(scope, bindings);
};

const collectBindings = (source: ParsedSource): BindingScopes => {
  const parents = new Map<Node, Node>();
  const scopes: BindingScopes = { parents, bindings: new Map() };
  walkSyntax(source.program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (parent !== undefined) {
      parents.set(node, parent);
    }
    if (node.type === "VariableDeclarator") {
      const initializer = node.id.type === "Identifier" ? node.init : null;
      for (const name of bindingNames(node.id)) {
        bindName({ scopes, node, name, initializer });
      }
    }
    if (node.type === "CatchClause" && node.param !== null) {
      for (const name of bindingNames(node.param)) {
        bindName({ scopes, node, name, own: true });
      }
    }
    for (const parameter of parametersOf(node) ?? []) {
      for (const name of bindingNames(parameter)) {
        bindName({ scopes, node, name, own: true });
      }
    }
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "TSDeclareFunction" ||
        node.type === "ClassDeclaration") &&
      node.id
    ) {
      bindName({ scopes, node, name: node.id.name });
    }
    if (
      node.type === "ImportDefaultSpecifier" ||
      node.type === "ImportSpecifier" ||
      node.type === "ImportNamespaceSpecifier"
    ) {
      bindName({ scopes, node, name: node.local.name });
    }
  });
  return scopes;
};

type LookupBindingOptions = {
  scopes: BindingScopes;
  node: Node;
  name: string;
};

const lookupBinding = ({
  scopes,
  node,
  name,
}: LookupBindingOptions): Expression | null | undefined => {
  for (
    let scope: Node | undefined = node;
    scope !== undefined;
    scope = scopes.parents.get(scope)
  ) {
    const bindings = scopes.bindings.get(scope);
    if (bindings?.has(name)) {
      return bindings.get(name);
    }
  }
  return undefined;
};

type ReflectedGlobalMemberOptions = {
  scopes: BindingScopes;
  node: Node;
};

const reflectedGlobalMember = ({
  scopes,
  node,
}: ReflectedGlobalMemberOptions) => {
  const value = unwrap(node);
  if (value.type !== "CallExpression") {
    return undefined;
  }
  const callee = unwrap(value.callee);
  if (callee.type !== "MemberExpression" || memberName(callee) !== "get") {
    return undefined;
  }
  const receiver = unwrap(callee.object);
  if (
    receiver.type !== "Identifier" ||
    receiver.name !== "Reflect" ||
    lookupBinding({ scopes, node: receiver, name: receiver.name }) !== undefined
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
    name: member && literalText(member),
  };
};

type GlobalObjectNameOptions = {
  scopes: BindingScopes;
  node: Node;
  seen?: Set<Node>;
};

const globalObjectName = ({
  scopes,
  node,
  seen = new Set<Node>(),
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
  if (value.type === "MemberExpression") {
    const root = globalObjectName({ scopes, node: value.object, seen });
    const name = memberName(value);
    return root && name && GLOBAL_ROOTS.has(name) ? name : undefined;
  }
  if (value.type !== "Identifier") {
    return undefined;
  }
  const initializer = lookupBinding({ scopes, node: value, name: value.name });
  if (initializer === undefined) {
    return GLOBAL_ROOTS.has(value.name) ? value.name : undefined;
  }
  if (initializer === null) {
    return undefined;
  }
  return globalObjectName({ scopes, node: initializer, seen });
};

type ObjectIdentityOptions = {
  scopes: BindingScopes;
  node: Node;
  seen?: Set<Node>;
};

const isReflectObject = ({
  scopes,
  node,
  seen = new Set<Node>(),
}: ObjectIdentityOptions): boolean => {
  const value = unwrap(node);
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (value.type === "Identifier") {
    const initializer = lookupBinding({
      scopes,
      node: value,
      name: value.name,
    });
    if (initializer === undefined) {
      return value.name === "Reflect";
    }
    return (
      initializer !== null &&
      isReflectObject({ scopes, node: initializer, seen })
    );
  }
  if (value.type === "MemberExpression") {
    return (
      globalObjectName({ scopes, node: value.object }) !== undefined &&
      memberName(value) === "Reflect"
    );
  }
  return false;
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
    module === canonicalModuleId(LOCAL_MODULE_LOADER_OWNER, file) ||
    module.endsWith(`/${canonicalModuleId(LOCAL_MODULE_LOADER_OWNER, file)}`)
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
  if (LOCAL_BETTER_AUTH_MODULES.has(module)) {
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

// The nodes the compiler API calls type nodes, including heritage clauses
// (`implements X`) and instantiation expressions (`f<T>`).
const TYPE_NODES: ReadonlySet<string> = new Set([
  "TSAnyKeyword",
  "TSBigIntKeyword",
  "TSBooleanKeyword",
  "TSIntrinsicKeyword",
  "TSNeverKeyword",
  "TSNullKeyword",
  "TSNumberKeyword",
  "TSObjectKeyword",
  "TSStringKeyword",
  "TSSymbolKeyword",
  "TSUndefinedKeyword",
  "TSUnknownKeyword",
  "TSVoidKeyword",
  "TSArrayType",
  "TSConditionalType",
  "TSConstructorType",
  "TSFunctionType",
  "TSImportType",
  "TSIndexedAccessType",
  "TSInferType",
  "TSIntersectionType",
  "TSLiteralType",
  "TSMappedType",
  "TSNamedTupleMember",
  "TSOptionalType",
  "TSRestType",
  "TSTemplateLiteralType",
  "TSThisType",
  "TSTupleType",
  "TSTypeLiteral",
  "TSTypeOperator",
  "TSTypePredicate",
  "TSTypeQuery",
  "TSTypeReference",
  "TSUnionType",
  "TSParenthesizedType",
  "JSDocNullableType",
  "JSDocNonNullableType",
  "JSDocUnknownType",
  "TSTypeAnnotation",
  "TSTypeParameterInstantiation",
  "TSInstantiationExpression",
  "TSInterfaceHeritage",
  "TSClassImplements",
]);

const isTypeNode = (node: Node): boolean => TYPE_NODES.has(node.type);

const isInsideType = (scopes: BindingScopes, node: Node): boolean => {
  for (
    let ancestor = scopes.parents.get(node);
    ancestor !== undefined &&
    !ancestor.type.endsWith("Statement") &&
    !ancestor.type.endsWith("Declaration");
    ancestor = scopes.parents.get(ancestor)
  ) {
    if (isTypeNode(ancestor)) {
      return true;
    }
  }
  return false;
};

// Null for a side-effect, default or namespace import.
const moduleNamesFromImport = (
  node: ImportDeclaration,
  sourceText: string,
): readonly string[] | null => {
  // `import "x"` has no clause, where `import {} from "x"` names nothing.
  const clauseless =
    node.specifiers.length === 0 &&
    sourceText.slice(node.start, node.source.start).trim() === "import";
  if (
    clauseless ||
    node.specifiers.some((specifier) => specifier.type !== "ImportSpecifier")
  ) {
    return null;
  }
  return node.specifiers.flatMap((specifier) =>
    specifier.type === "ImportSpecifier" && specifier.importKind !== "type"
      ? [exportName(specifier.imported)]
      : [],
  );
};

type VisitModuleLoadOptions = {
  node: Node;
  scopes: BindingScopes;
  register: ModuleRegistration;
  file: string;
  sourceText: string;
  capabilities: Set<string>;
};

const visitModuleLoad = ({
  node,
  scopes,
  register,
  file,
  sourceText,
  capabilities,
}: VisitModuleLoadOptions): void => {
  if (node.type === "ImportDeclaration") {
    if (node.importKind === "type") {
      return;
    }
    const names = moduleNamesFromImport(node, sourceText);
    if (names === null || names.length > 0) {
      register(node.source.value, names);
    }
    return;
  }
  if (node.type === "ExportAllDeclaration" && node.exportKind !== "type") {
    register(node.source.value, null);
    return;
  }
  if (
    node.type === "ExportNamedDeclaration" &&
    node.exportKind !== "type" &&
    node.source
  ) {
    const names = node.specifiers.flatMap((specifier) =>
      specifier.exportKind === "type" ? [] : [exportName(specifier.local)],
    );
    if (names.length > 0) {
      register(node.source.value, names);
    }
    return;
  }
  if (
    node.type === "TSImportEqualsDeclaration" &&
    node.importKind !== "type" &&
    node.moduleReference.type === "TSExternalModuleReference"
  ) {
    const specifier = literalText(unwrap(node.moduleReference.expression));
    if (specifier !== undefined) {
      register(specifier, null);
    }
    return;
  }
  let specifier: Node | undefined;
  if (node.type === "ImportExpression") {
    specifier = node.source;
  } else if (node.type === "CallExpression") {
    const callee = unwrap(node.callee);
    if (
      callee.type !== "Identifier" ||
      callee.name !== "require" ||
      lookupBinding({ scopes, node: callee, name: callee.name }) !== undefined
    ) {
      return;
    }
    specifier = node.arguments.at(0);
  } else {
    return;
  }
  const value = specifier && literalText(unwrap(specifier));
  if (value !== undefined) {
    register(value, dynamicLoadNames(scopes, node));
    return;
  }
  if (node.type === "ImportExpression" && file === LOCAL_MODULE_LOADER_OWNER) {
    capabilities.add("local:module-import");
    return;
  }
  capabilities.add(INDIRECT_TRANSPORT);
};

// Whether `node` names a member, a declared property or an import/export
// binding rather than reading a value.
const isGlobalNamePosition = (scopes: BindingScopes, node: Node): boolean => {
  const parent = scopes.parents.get(node);
  if (parent === undefined) {
    return false;
  }
  if (parent.type === "MemberExpression") {
    return !parent.computed && parent.property === node;
  }
  // Object literal entries and methods, and the member a destructuring
  // entry names (`{ fetch: local }`); a shorthand entry reads its binding.
  if (parent.type === "Property") {
    return (
      parent.key === node &&
      !parent.computed &&
      !parent.shorthand &&
      parent.kind === "init"
    );
  }
  if (
    parent.type === "MethodDefinition" ||
    parent.type === "TSAbstractMethodDefinition"
  ) {
    return parent.key === node && !parent.computed && parent.kind === "method";
  }
  if (
    parent.type === "PropertyDefinition" ||
    parent.type === "TSAbstractPropertyDefinition" ||
    parent.type === "AccessorProperty" ||
    parent.type === "TSAbstractAccessorProperty" ||
    parent.type === "TSPropertySignature"
  ) {
    return parent.key === node && !parent.computed;
  }
  if (parent.type === "TSMethodSignature") {
    return parent.key === node && !parent.computed && parent.kind === "method";
  }
  return parent.type === "ImportSpecifier" || parent.type === "ExportSpecifier";
};

type VisitGlobalReferenceOptions = {
  node: Node;
  scopes: BindingScopes;
  capabilities: Set<string>;
};

type DestructuredMember = { member: string | undefined; isRest: boolean };
type GlobalDestructuring = {
  members: DestructuredMember[];
  value: Expression;
  isAssignment: boolean;
};

const destructuredMembers = (
  pattern: Extract<Node, { type: "ObjectPattern" }>,
): DestructuredMember[] =>
  pattern.properties.map((element) => ({
    member: destructuredMemberName(element),
    isRest: element.type === "RestElement",
  }));

const globalDestructuring = (node: Node): GlobalDestructuring | undefined => {
  if (
    node.type === "VariableDeclarator" &&
    node.id.type === "ObjectPattern" &&
    node.init
  ) {
    return {
      members: destructuredMembers(node.id),
      value: node.init,
      isAssignment: false,
    };
  }
  if (
    node.type !== "AssignmentExpression" ||
    node.operator !== "=" ||
    node.left.type !== "ObjectPattern"
  ) {
    return undefined;
  }
  return {
    members: destructuredMembers(node.left),
    value: node.right,
    isAssignment: true,
  };
};

const visitGlobalDestructuring = ({
  node,
  scopes,
  capabilities,
}: VisitGlobalReferenceOptions): void => {
  const destructuring = globalDestructuring(node);
  if (!destructuring) {
    return;
  }
  const object = globalObjectName({ scopes, node: destructuring.value });
  if (object && destructuring.isAssignment) {
    capabilities.add(INDIRECT_TRANSPORT);
  }
  for (const { member, isRest } of destructuring.members) {
    if (
      object &&
      (isRest ||
        member === undefined ||
        member === "Reflect" ||
        GLOBAL_ROOTS.has(member))
    ) {
      capabilities.add(INDIRECT_TRANSPORT);
    }
    registerGlobal({ capabilities, object, name: member });
  }
};

const visitGlobalReference = ({
  node,
  scopes,
  capabilities,
}: VisitGlobalReferenceOptions): void => {
  if (node.type === "MemberExpression") {
    const object = globalObjectName({ scopes, node: node.object });
    const name = memberName(node);
    if (object && name === undefined) {
      capabilities.add(INDIRECT_TRANSPORT);
    }
    registerGlobal({
      capabilities,
      object,
      name,
    });
  }
  visitGlobalDestructuring({ node, scopes, capabilities });
  if (node.type === "CallExpression") {
    const callee = unwrap(node.callee);
    if (
      callee.type === "MemberExpression" &&
      isReflectObject({ scopes, node: callee.object })
    ) {
      const target = node.arguments.at(0);
      const object = target
        ? globalObjectName({ scopes, node: target })
        : undefined;
      if (object) {
        capabilities.add(INDIRECT_TRANSPORT);
        const key = node.arguments.at(1);
        registerGlobal({
          capabilities,
          object,
          name: key && literalText(unwrap(key)),
        });
      }
    }
  }
  if (
    node.type === "VariableDeclarator" &&
    node.id.type === "Identifier" &&
    node.init &&
    (globalObjectName({ scopes, node: node.init }) !== undefined ||
      isReflectObject({ scopes, node: node.init }))
  ) {
    capabilities.add(INDIRECT_TRANSPORT);
  }
  if (
    node.type === "AssignmentExpression" &&
    node.operator === "=" &&
    (globalObjectName({ scopes, node: node.right }) !== undefined ||
      isReflectObject({ scopes, node: node.right }))
  ) {
    capabilities.add(INDIRECT_TRANSPORT);
  }
  if (
    node.type === "Identifier" &&
    GLOBAL_TRANSPORT_NAMES.has(node.name) &&
    !isInsideType(scopes, node) &&
    lookupBinding({ scopes, node, name: node.name }) === undefined &&
    !isGlobalNamePosition(scopes, node)
  ) {
    capabilities.add(`global:${node.name}`);
  }
};

type VisitContext = {
  capabilities: Set<string>;
  file: string;
  scopes: BindingScopes;
};

const visitSource = (source: ParsedSource, context: VisitContext): void => {
  const register: ModuleRegistration = (specifier, names) => {
    registerModule({
      capabilities: context.capabilities,
      file: context.file,
      specifier,
      names,
    });
  };
  // A class's `extends` expression is a heritage clause, a type position.
  const heritage = new Set<Node>();
  walkSyntax(source.program, (node) => {
    if (isTypeNode(node) || heritage.has(node)) {
      return "skip-children";
    }
    if (
      (node.type === "ClassDeclaration" || node.type === "ClassExpression") &&
      node.superClass
    ) {
      heritage.add(node.superClass);
    }
    visitModuleLoad({
      node,
      scopes: context.scopes,
      register,
      file: context.file,
      sourceText: source.sourceText,
      capabilities: context.capabilities,
    });
    visitGlobalReference({
      node,
      scopes: context.scopes,
      capabilities: context.capabilities,
    });
    return undefined;
  });
};

/** Enumerate transport capability acquisition, including captured functions. */
export const outboundTransportReferences = ({
  file,
  text,
}: OutboundTransportReferencesOptions): string[] => {
  const source = parseSyntax({ fileName: file, text });
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
