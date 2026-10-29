// Browser writes that do not declare a catalog capability.
//
// A web write runs through `invokeCapability(id, (request) => ...)` or the
// `mutationFn` of `useCapabilityMutation({ capability: id, ... })`, which send
// the declared capability with the request. Every other Eden write
// (`post`/`put`/`patch`/`delete` on a client imported from the Eden client
// modules under any specifier, followed through same-file aliases) is counted
// here; the ratchet keeps each file's count from growing. The capability-request
// lint rule checks the shape of the declared writes and shares its client
// definition (`.oxlint-plugins/api-client-chain.ts`).
import {
  API_CLIENT_CLIENT_EXPORTS,
  API_CLIENT_CLIENT_MODULES,
  API_CLIENT_WRITE_METHODS,
} from "../.oxlint-plugins/api-client-chain.ts";
import { canonicalModuleId } from "../.oxlint-plugins/module-id.ts";
import { INTERNAL_UI_TRANSPORT_ROUTES } from "../packages/api-contract/src/internal-ui-transport.ts";
import {
  type ArrowFunctionExpression,
  type CallExpression,
  type Expression,
  type IdentifierReference,
  type Node,
  type Program,
  walk,
} from "../packages/scripts/src/syntax-tree";
import { parseSyntax } from "./parse-memo";

const INVOKE_CAPABILITY = "invokeCapability";
const INVOKE_APP_ONLY_WRITE = "invokeAppOnlyWrite";
const USE_CAPABILITY_MUTATION = "useCapabilityMutation";
// A cheap text test before parsing: every specifier of a client module ends
// in its file name, whether aliased or relative.
const MAY_IMPORT_CLIENT = /["'](?:[^"']*\/)?api["']/u;
const INTERNAL_UI_TRANSPORT_OWNER = "apps/web/src/lib/api.ts";
const INTERNAL_UI_TRANSPORT_MODULE = "@stll/api-contract/internal-ui-transport";

const directProperty = (value: Expression, name: string): Expression | null =>
  value.type === "MemberExpression" &&
  !value.computed &&
  !value.optional &&
  value.property.type === "Identifier" &&
  value.property.name === name
    ? value.object
    : null;

const shorthandBody = (value: Expression, name: string): boolean => {
  if (value.type !== "ObjectExpression" || value.properties.length !== 1) {
    return false;
  }
  const property = value.properties.at(0);
  return (
    property?.type === "Property" &&
    property.shorthand &&
    property.key.type === "Identifier" &&
    property.key.name === name
  );
};

const exactMemberCall = (
  value: Expression,
  name: string,
  argument: string,
): Expression | null => {
  if (
    value.type !== "CallExpression" ||
    value.optional ||
    value.arguments.length !== 1
  ) {
    return null;
  }
  const body = value.arguments.at(0);
  if (
    body === undefined ||
    body.type === "SpreadElement" ||
    !shorthandBody(body, argument)
  ) {
    return null;
  }
  return directProperty(value.callee, name);
};

const exactInternalUiWrite = (
  call: CallExpression,
  routeId: string,
): boolean => {
  const methodTarget = directProperty(call.callee, "post");
  const body = call.arguments.at(0);
  if (
    methodTarget === null ||
    call.arguments.length !== 1 ||
    body === undefined ||
    body.type === "SpreadElement" ||
    body.type !== "ObjectExpression"
  ) {
    return false;
  }
  if (routeId === INTERNAL_UI_TRANSPORT_ROUTES.mcpConnectorConnect.id) {
    const connector = directProperty(methodTarget, "connect");
    const mcp =
      connector === null
        ? null
        : exactMemberCall(connector, "connectors", "slug");
    const api = mcp === null ? null : directProperty(mcp, "mcp");
    return (
      body.properties.length === 0 &&
      api?.type === "Identifier" &&
      api.name === "api"
    );
  }
  if (routeId === INTERNAL_UI_TRANSPORT_ROUTES.chatConnectorReceipt.id) {
    const threads = exactMemberCall(methodTarget, "connectors", "toolCallId");
    const chat =
      threads === null ? null : exactMemberCall(threads, "threads", "threadId");
    const api = chat === null ? null : directProperty(chat, "chat");
    return (
      shorthandBody(body, "decision") &&
      api?.type === "Identifier" &&
      api.name === "api"
    );
  }
  return false;
};

const hasDirectNamedImport = (
  program: Program,
  file: string,
  moduleId: string,
  name: string,
): boolean =>
  program.body.some(
    (statement) =>
      statement.type === "ImportDeclaration" &&
      statement.importKind !== "type" &&
      canonicalModuleId(statement.source.value, file) === moduleId &&
      statement.specifiers.some(
        (specifier) =>
          specifier.type === "ImportSpecifier" &&
          specifier.importKind !== "type" &&
          specifier.imported.type === "Identifier" &&
          specifier.imported.name === name &&
          specifier.local.name === name,
      ),
  );

const objectProperty = (
  object: Expression,
  name: string,
): Expression | null => {
  if (object.type !== "ObjectExpression") {
    return null;
  }
  const matches = object.properties.filter(
    (property) =>
      property.type === "Property" &&
      !property.computed &&
      property.key.type === "Identifier" &&
      property.key.name === name,
  );
  const property = matches.at(0);
  return matches.length === 1 && property?.type === "Property"
    ? property.value
    : null;
};

const internalUiAction = (
  program: Program,
  exportName: string,
  routeKey: string,
  actionName: string,
): ArrowFunctionExpression | null => {
  for (const statement of program.body) {
    if (
      statement.type !== "ExportNamedDeclaration" ||
      statement.declaration?.type !== "VariableDeclaration"
    ) {
      continue;
    }
    for (const declaration of statement.declaration.declarations) {
      if (
        declaration.id.type !== "Identifier" ||
        declaration.id.name !== exportName ||
        declaration.init === null
      ) {
        continue;
      }
      const initializer =
        declaration.init.type === "TSAsExpression"
          ? declaration.init.expression
          : declaration.init;
      const route = objectProperty(initializer, "route");
      const manifest = route === null ? null : directProperty(route, routeKey);
      if (
        manifest?.type !== "Identifier" ||
        manifest.name !== "INTERNAL_UI_TRANSPORT_ROUTES"
      ) {
        return null;
      }
      const action = objectProperty(initializer, actionName);
      return action?.type === "ArrowFunctionExpression" ? action : null;
    }
  }
  return null;
};

const definesApiClient = (program: Program, file: string): boolean => {
  if (
    file !== INTERNAL_UI_TRANSPORT_OWNER ||
    !hasDirectNamedImport(program, file, "@stll/api-client", "createApiClient")
  ) {
    return false;
  }
  const declarations = program.body.flatMap((statement) =>
    statement.type === "ExportNamedDeclaration" &&
    statement.declaration?.type === "VariableDeclaration"
      ? statement.declaration.declarations
      : [],
  );
  const client = declarations.find(
    (declaration) =>
      declaration.id.type === "Identifier" &&
      declaration.id.name === "apiClient",
  );
  const versioned = declarations.find(
    (declaration) =>
      declaration.id.type === "Identifier" && declaration.id.name === "api",
  );
  return (
    client?.init?.type === "CallExpression" &&
    client.init.callee.type === "Identifier" &&
    client.init.callee.name === "createApiClient" &&
    versioned?.init?.type === "MemberExpression" &&
    !versioned.init.computed &&
    versioned.init.object.type === "Identifier" &&
    versioned.init.object.name === "apiClient" &&
    versioned.init.property.type === "Identifier" &&
    versioned.init.property.name === "v1"
  );
};

const isOwnedInternalUiWrite = (
  program: Program,
  file: string,
  call: CallExpression,
  ancestors: readonly Node[],
): boolean => {
  if (
    file !== INTERNAL_UI_TRANSPORT_OWNER ||
    !definesApiClient(program, file) ||
    !hasDirectNamedImport(
      program,
      file,
      INTERNAL_UI_TRANSPORT_MODULE,
      "INTERNAL_UI_TRANSPORT_ROUTES",
    )
  ) {
    return false;
  }
  const dispatches = [
    [
      "mcpConnectorConnection",
      "mcpConnectorConnect",
      INTERNAL_UI_TRANSPORT_ROUTES.mcpConnectorConnect.id,
      "start",
    ],
    [
      "chatConnectorReceipt",
      "chatConnectorReceipt",
      INTERNAL_UI_TRANSPORT_ROUTES.chatConnectorReceipt.id,
      "submit",
    ],
  ] as const;
  for (const [name, routeKey, routeId, actionName] of dispatches) {
    const action = internalUiAction(program, name, routeKey, actionName);
    const nearest = ancestors.findLast((ancestor, index) =>
      isFunctionLike(ancestor, ancestors[index - 1]),
    );
    if (action === null || nearest !== action) {
      continue;
    }
    const matchingCalls: CallExpression[] = [];
    walk(action, (node, parents) => {
      if (
        node.type === "CallExpression" &&
        parents.findLast((parent, index) =>
          isFunctionLike(parent, parents[index - 1]),
        ) === action &&
        exactInternalUiWrite(node, routeId)
      ) {
        matchingCalls.push(node);
      }
    });
    return matchingCalls.at(0) === call;
  }
  return false;
};

const clientImports = (program: Program, file: string): Set<string> => {
  const names = new Set<string>();
  if (file === INTERNAL_UI_TRANSPORT_OWNER) {
    for (const name of API_CLIENT_CLIENT_EXPORTS) {
      names.add(name);
    }
  }
  for (const statement of program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.importKind === "type" ||
      !API_CLIENT_CLIENT_MODULES.includes(
        canonicalModuleId(statement.source.value, file),
      )
    ) {
      continue;
    }
    // Every value the client module exports is counted, not a list of client
    // names: a client added under a new name (a per-domain client) is a client
    // all the same, and the merge-base is measured by this same code.
    for (const specifier of statement.specifiers) {
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.importKind !== "type"
      ) {
        names.add(specifier.local.name);
      }
    }
  }
  return names;
};

const chainRoot = (expression: Expression): IdentifierReference | null => {
  if (expression.type === "Identifier") {
    return expression;
  }
  if (expression.type === "MemberExpression") {
    return chainRoot(expression.object);
  }
  if (expression.type === "CallExpression") {
    return chainRoot(expression.callee);
  }
  if (expression.type === "AwaitExpression") {
    return chainRoot(expression.argument);
  }
  // An optional chain (`api?.items`) is wrapped as a whole.
  if (
    expression.type === "ParenthesizedExpression" ||
    expression.type === "ChainExpression"
  ) {
    return chainRoot(expression.expression);
  }
  return null;
};

// Same-file `const` names whose initializer is rooted at a client import.
const clientNames = (program: Program, file: string): Set<string> => {
  const names = clientImports(program, file);
  if (names.size === 0) {
    return names;
  }
  // Any declared alias counts, reassignable or not: an over-count only keeps
  // a write visible, and both trees are measured the same way.
  const aliases: { name: string; root: string }[] = [];
  walk(program, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      const root = node.init === null ? null : chainRoot(node.init);
      if (root !== null) {
        aliases.push({ name: node.id.name, root: root.name });
      }
    }
  });
  let grew = true;
  while (grew) {
    grew = false;
    for (const { name, root } of aliases) {
      if (!names.has(name) && names.has(root)) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
};

// Plain functions and methods; constructors and accessors leave a write to
// the function around them.
const isFunctionLike = (node: Node, parent: Node | undefined): boolean =>
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionDeclaration" ||
  (node.type === "FunctionExpression" &&
    !(
      (parent?.type === "MethodDefinition" && parent.kind !== "method") ||
      (parent?.type === "Property" && parent.kind !== "init")
    ));

const calleeName = (call: CallExpression): string | null =>
  call.callee.type === "Identifier" ? call.callee.name : null;

// Whether `fn`, whose nearest ancestors are `parents` (nearest last), is the
// callback that receives the declared capability request.
const isCapabilityCallback = (fn: Node, parents: readonly Node[]): boolean => {
  const parent = parents.at(-1);
  if (
    parent?.type === "CallExpression" &&
    ((calleeName(parent) === INVOKE_CAPABILITY &&
      parent.arguments.at(1) === fn) ||
      (calleeName(parent) === INVOKE_APP_ONLY_WRITE &&
        parent.arguments.at(1) === fn))
  ) {
    return true;
  }
  // `mutationFn: (request) => ...` and `mutationFn(request) { ... }` alike.
  if (
    parent?.type !== "Property" ||
    parent.computed ||
    parent.key.type !== "Identifier" ||
    parent.key.name !== "mutationFn"
  ) {
    return false;
  }
  const options = parents.at(-2);
  const call = parents.at(-3);
  return (
    options?.type === "ObjectExpression" &&
    call?.type === "CallExpression" &&
    calleeName(call) === USE_CAPABILITY_MUTATION &&
    call.arguments.at(0) === options
  );
};

export const countUndeclaredApiClientWrites = (
  content: string,
  file: string,
): number => {
  if (
    !MAY_IMPORT_CLIENT.test(content) &&
    file !== INTERNAL_UI_TRANSPORT_OWNER
  ) {
    return 0;
  }
  const { program } = parseSyntax({ fileName: file, text: content });
  const clients = clientNames(program, file);
  if (clients.size === 0) {
    return 0;
  }
  let count = 0;
  // `client.items.post(...)` and `client.items["post"](...)` alike.
  const writeTarget = (callee: Expression): Expression | null => {
    if (callee.type !== "MemberExpression") {
      return null;
    }
    const { property } = callee;
    if (!callee.computed) {
      return property.type === "Identifier" &&
        API_CLIENT_WRITE_METHODS.has(property.name)
        ? callee.object
        : null;
    }
    let method: string | null | undefined;
    if (property.type === "Literal" && typeof property.value === "string") {
      method = property.value;
    } else if (
      property.type === "TemplateLiteral" &&
      property.expressions.length === 0
    ) {
      method = property.quasis.at(0)?.value.cooked;
    }
    return typeof method === "string" && API_CLIENT_WRITE_METHODS.has(method)
      ? callee.object
      : null;
  };
  walk(program, (node, ancestors) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const target = writeTarget(node.callee);
    if (target === null) {
      return;
    }
    const root = chainRoot(target);
    if (root === null || !clients.has(root.name)) {
      return;
    }
    const fnIndex = ancestors.findLastIndex((ancestor, index) =>
      isFunctionLike(ancestor, ancestors[index - 1]),
    );
    const fn = ancestors[fnIndex];
    if (
      (fn === undefined ||
        !isCapabilityCallback(fn, ancestors.slice(0, fnIndex))) &&
      !isOwnedInternalUiWrite(program, file, node, ancestors)
    ) {
      count += 1;
    }
  });
  return count;
};
