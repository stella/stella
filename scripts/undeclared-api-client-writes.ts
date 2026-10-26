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
  API_CLIENT_CLIENT_MODULES,
  API_CLIENT_WRITE_METHODS,
} from "../.oxlint-plugins/api-client-chain.ts";
import { canonicalModuleId } from "../.oxlint-plugins/module-id.ts";
import { parseSource } from "./parse-memo";

const INVOKE_CAPABILITY = "invokeCapability";
const USE_CAPABILITY_MUTATION = "useCapabilityMutation";
// A cheap text test before parsing: every specifier of a client module ends
// in its file name, whether aliased or relative.
const MAY_IMPORT_CLIENT = /["'](?:[^"']*\/)?api["']/u;

const clientImports = (source: ts.SourceFile, file: string): Set<string> => {
  const names = new Set<string>();
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
  if (!MAY_IMPORT_CLIENT.test(content)) {
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
    const target = ts.isCallExpression(node)
      ? writeTarget(node.expression)
      : null;
    if (target !== null) {
      const root = chainRoot(target);
      const fn = nearestFunction(node);
      if (
        root !== null &&
        clients.has(root.text) &&
        (fn === null || !isCapabilityCallback(fn))
      ) {
        count += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
};
