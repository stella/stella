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
import ts from "typescript6";

import {
  API_CLIENT_CLIENT_EXPORTS,
  API_CLIENT_CLIENT_MODULES,
  API_CLIENT_WRITE_METHODS,
} from "../.oxlint-plugins/api-client-chain.ts";
import { canonicalModuleId } from "../.oxlint-plugins/module-id.ts";
import { INTERNAL_UI_TRANSPORT_ROUTES } from "../packages/api-contract/src/internal-ui-transport.ts";
import { parseSource } from "./parse-memo";

const INVOKE_CAPABILITY = "invokeCapability";
const USE_CAPABILITY_MUTATION = "useCapabilityMutation";
// A cheap text test before parsing: every specifier of a client module ends
// in its file name, whether aliased or relative.
const MAY_IMPORT_CLIENT = /["'](?:[^"']*\/)?api["']/u;
const INTERNAL_UI_TRANSPORT_OWNER = "apps/web/src/lib/api.ts";
const INTERNAL_UI_TRANSPORT_MODULE = "@stll/api-contract/internal-ui-transport";

const directProperty = (
  value: ts.Expression,
  name: string,
): ts.Expression | null =>
  ts.isPropertyAccessExpression(value) &&
  value.questionDotToken === undefined &&
  value.name.text === name
    ? value.expression
    : null;

const shorthandBody = (value: ts.Expression, name: string): boolean => {
  if (!ts.isObjectLiteralExpression(value) || value.properties.length !== 1) {
    return false;
  }
  const property = value.properties.at(0);
  return (
    property !== undefined &&
    ts.isShorthandPropertyAssignment(property) &&
    property.name.text === name
  );
};

const exactMemberCall = (
  value: ts.Expression,
  name: string,
  argument: string,
): ts.Expression | null => {
  const body = ts.isCallExpression(value) ? value.arguments.at(0) : undefined;
  if (
    !ts.isCallExpression(value) ||
    value.questionDotToken !== undefined ||
    value.arguments.length !== 1 ||
    body === undefined ||
    !shorthandBody(body, argument)
  ) {
    return null;
  }
  return directProperty(value.expression, name);
};

const exactInternalUiWrite = (
  call: ts.CallExpression,
  routeId: string,
): boolean => {
  const methodTarget = directProperty(call.expression, "post");
  const body = call.arguments.at(0);
  if (
    methodTarget === null ||
    call.arguments.length !== 1 ||
    body === undefined ||
    !ts.isObjectLiteralExpression(body)
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
      api !== null &&
      ts.isIdentifier(api) &&
      api.text === "api"
    );
  }
  if (routeId === INTERNAL_UI_TRANSPORT_ROUTES.chatConnectorReceipt.id) {
    const threads = exactMemberCall(methodTarget, "connectors", "toolCallId");
    const chat =
      threads === null ? null : exactMemberCall(threads, "threads", "threadId");
    const api = chat === null ? null : directProperty(chat, "chat");
    return (
      shorthandBody(body, "decision") &&
      api !== null &&
      ts.isIdentifier(api) &&
      api.text === "api"
    );
  }
  return false;
};

const hasDirectNamedImport = (
  source: ts.SourceFile,
  file: string,
  moduleId: string,
  name: string,
): boolean =>
  source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      canonicalModuleId(statement.moduleSpecifier.text, file) === moduleId &&
      statement.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) =>
          !element.isTypeOnly &&
          element.propertyName === undefined &&
          element.name.text === name,
      ),
  );

const objectProperty = (
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | null => {
  const matches = object.properties.filter(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name,
  );
  const property = matches.at(0);
  return matches.length === 1 &&
    property !== undefined &&
    ts.isPropertyAssignment(property)
    ? property.initializer
    : null;
};

const internalUiAction = (
  source: ts.SourceFile,
  exportName: string,
  routeKey: string,
  actionName: string,
): ts.ArrowFunction | null => {
  for (const statement of source.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== exportName ||
        declaration.initializer === undefined
      ) {
        continue;
      }
      const initializer = ts.isAsExpression(declaration.initializer)
        ? declaration.initializer.expression
        : declaration.initializer;
      if (!ts.isObjectLiteralExpression(initializer)) {
        return null;
      }
      const route = objectProperty(initializer, "route");
      const manifest = route === null ? null : directProperty(route, routeKey);
      if (
        manifest === null ||
        !ts.isIdentifier(manifest) ||
        manifest.text !== "INTERNAL_UI_TRANSPORT_ROUTES"
      ) {
        return null;
      }
      const action = objectProperty(initializer, actionName);
      return action !== null && ts.isArrowFunction(action) ? action : null;
    }
  }
  return null;
};

const isOwnedInternalUiWrite = (
  source: ts.SourceFile,
  file: string,
  call: ts.CallExpression,
): boolean => {
  if (
    file !== INTERNAL_UI_TRANSPORT_OWNER ||
    !definesApiClient(source, file) ||
    !hasDirectNamedImport(
      source,
      file,
      INTERNAL_UI_TRANSPORT_MODULE,
      "INTERNAL_UI_TRANSPORT_ROUTES",
    )
  ) {
    return false;
  }
  const dispatches = [
    {
      name: "mcpConnectorConnection",
      routeKey: "mcpConnectorConnect",
      routeId: INTERNAL_UI_TRANSPORT_ROUTES.mcpConnectorConnect.id,
      action: "start",
    },
    {
      name: "chatConnectorReceipt",
      routeKey: "chatConnectorReceipt",
      routeId: INTERNAL_UI_TRANSPORT_ROUTES.chatConnectorReceipt.id,
      action: "submit",
    },
  ] as const;
  for (const dispatch of dispatches) {
    const action = internalUiAction(
      source,
      dispatch.name,
      dispatch.routeKey,
      dispatch.action,
    );
    if (action === null || nearestFunction(call) !== action) {
      continue;
    }
    const matchingCalls: ts.CallExpression[] = [];
    const collect = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        nearestFunction(node) === action &&
        exactInternalUiWrite(node, dispatch.routeId)
      ) {
        matchingCalls.push(node);
      }
      ts.forEachChild(node, collect);
    };
    collect(action);
    return matchingCalls.at(0) === call;
  }
  return false;
};

/** Only the actual client definition module owns its local API bindings. */
const definesApiClient = (source: ts.SourceFile, file: string): boolean => {
  if (
    file !== INTERNAL_UI_TRANSPORT_OWNER ||
    !hasDirectNamedImport(source, file, "@stll/api-client", "createApiClient")
  ) {
    return false;
  }
  const declarations = source.statements
    .filter(ts.isVariableStatement)
    .filter((statement) =>
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ),
    )
    .flatMap((statement) => [...statement.declarationList.declarations]);
  const client = declarations.find(
    (declaration) =>
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === "apiClient",
  );
  const versioned = declarations.find(
    (declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === "api",
  );
  const clientInitializer = client?.initializer;
  const versionedInitializer = versioned?.initializer;
  return (
    clientInitializer !== undefined &&
    ts.isCallExpression(clientInitializer) &&
    ts.isIdentifier(clientInitializer.expression) &&
    clientInitializer.expression.text === "createApiClient" &&
    versionedInitializer !== undefined &&
    ts.isPropertyAccessExpression(versionedInitializer) &&
    ts.isIdentifier(versionedInitializer.expression) &&
    versionedInitializer.expression.text === "apiClient" &&
    versionedInitializer.name.text === "v1"
  );
};

const clientImports = (source: ts.SourceFile, file: string): Set<string> => {
  const names = new Set<string>();
  if (file === INTERNAL_UI_TRANSPORT_OWNER) {
    for (const name of API_CLIENT_CLIENT_EXPORTS) {
      names.add(name);
    }
  }
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !API_CLIENT_CLIENT_MODULES.includes(
        canonicalModuleId(statement.moduleSpecifier.text, file),
      )
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (
      statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
      bindings === undefined ||
      !ts.isNamedImports(bindings)
    ) {
      continue;
    }
    // Every value the client module exports is counted, not a list of client
    // names: a client added under a new name (a per-domain client) is a client
    // all the same, and the merge-base is measured by this same code.
    for (const element of bindings.elements) {
      if (!element.isTypeOnly) {
        names.add(element.name.text);
      }
    }
  }
  return names;
};

const chainRoot = (expression: ts.Expression): ts.Identifier | null => {
  if (ts.isIdentifier(expression)) {
    return expression;
  }
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression) ||
    ts.isCallExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isAwaitExpression(expression)
  ) {
    return chainRoot(expression.expression);
  }
  return null;
};

// Same-file `const` names whose initializer is rooted at a client import.
const clientNames = (source: ts.SourceFile, file: string): Set<string> => {
  const names = clientImports(source, file);
  if (names.size === 0) {
    return names;
  }
  // Any declared alias counts, reassignable or not: an over-count only keeps
  // a write visible, and both trees are measured the same way.
  const aliases: { name: string; root: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const root =
        node.initializer === undefined ? null : chainRoot(node.initializer);
      if (root !== null) {
        aliases.push({ name: node.name.text, root: root.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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

const isFunctionLike = (node: ts.Node): boolean =>
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node);

const calleeName = (call: ts.CallExpression): string | null =>
  ts.isIdentifier(call.expression) ? call.expression.text : null;

// Whether `fn` is the callback that receives the declared capability request.
const isCapabilityCallback = (fn: ts.Node): boolean => {
  const parent = fn.parent;
  if (
    ts.isCallExpression(parent) &&
    calleeName(parent) === INVOKE_CAPABILITY &&
    parent.arguments.at(1) === fn
  ) {
    return true;
  }
  const property = ts.isMethodDeclaration(fn) ? fn : parent;
  if (
    !(ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) ||
    !ts.isIdentifier(property.name) ||
    property.name.text !== "mutationFn"
  ) {
    return false;
  }
  const options = property.parent;
  return (
    ts.isObjectLiteralExpression(options) &&
    ts.isCallExpression(options.parent) &&
    calleeName(options.parent) === USE_CAPABILITY_MUTATION &&
    options.parent.arguments.at(0) === options
  );
};

const nearestFunction = (node: ts.Node): ts.Node | null =>
  ts.findAncestor(node.parent, isFunctionLike) ?? null;

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
  const source = parseSource({ fileName: file, text: content });
  const clients = clientNames(source, file);
  if (clients.size === 0) {
    return 0;
  }
  let count = 0;
  // `client.items.post(...)` and `client.items["post"](...)` alike.
  const writeTarget = (callee: ts.Expression): ts.Expression | null => {
    if (ts.isPropertyAccessExpression(callee)) {
      return API_CLIENT_WRITE_METHODS.has(callee.name.text)
        ? callee.expression
        : null;
    }
    if (
      ts.isElementAccessExpression(callee) &&
      ts.isStringLiteralLike(callee.argumentExpression) &&
      API_CLIENT_WRITE_METHODS.has(callee.argumentExpression.text)
    ) {
      return callee.expression;
    }
    return null;
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const target = writeTarget(node.expression);
      if (target === null) {
        ts.forEachChild(node, visit);
        return;
      }
      const root = chainRoot(target);
      const fn = nearestFunction(node);
      if (
        root !== null &&
        clients.has(root.text) &&
        (fn === null || !isCapabilityCallback(fn)) &&
        !isOwnedInternalUiWrite(source, file, node)
      ) {
        count += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
};
