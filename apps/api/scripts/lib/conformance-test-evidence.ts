import { panic } from "better-result";
import path from "node:path";
import ts from "typescript";

export type ConformanceTestSource = { file: string; source: string };
export type HttpCallSource = "composed-api" | "standalone-app" | "fetch";

export type ConformanceTestEvidence = {
  /** Syntactic invocations only; these do not prove that a test ran. */
  handlerCalls: { endpoint: string; tests: string[] }[];
  httpCalls: {
    source: HttpCallSource;
    method: string;
    path: string;
    tests: string[];
  }[];
  mcpCalls: { mode: string; name: string; tests: string[] }[];
  unresolvedCalls: { handler: number; http: number; mcp: number };
};

const literal = (node: ts.Node | undefined): string | undefined =>
  node !== undefined &&
  (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;

const member = (node: ts.Expression) => {
  if (ts.isPropertyAccessExpression(node)) {
    return { receiver: node.expression, name: node.name.text };
  }
  if (ts.isElementAccessExpression(node)) {
    return {
      receiver: node.expression,
      name: literal(node.argumentExpression),
    };
  }
  return undefined;
};

const modulePath = (file: string, specifier: string) => {
  let resolved = specifier;
  if (specifier.startsWith("@/api/")) {
    resolved = `apps/api/src/${specifier.slice("@/api/".length)}`;
  } else if (specifier.startsWith(".")) {
    resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), specifier),
    );
  }
  return resolved.replace(/\.(?:js|ts)$/u, "");
};

/** Spreads, methods and duplicate keys can change the selected value. */
const fields = (node: ts.Node | undefined) => {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) {
    return undefined;
  }
  const result = new Map<string, ts.Expression>();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) {
      return undefined;
    }
    const name = ts.isIdentifier(property.name)
      ? property.name.text
      : literal(property.name);
    if (name === undefined || result.has(name)) {
      return undefined;
    }
    result.set(name, property.initializer);
  }
  return result;
};

const add = (map: Map<string, Set<string>>, key: string, file: string) => {
  const tests = map.get(key) ?? new Set<string>();
  tests.add(file);
  map.set(key, tests);
};

const request = (args: readonly ts.Expression[], source: HttpCallSource) => {
  const url = literal(args.at(0));
  const options = args.at(1);
  const init =
    options === undefined ? new Map<string, ts.Expression>() : fields(options);
  if (url === undefined || init === undefined || !URL.canParse(url)) {
    return undefined;
  }
  const method = init.has("method") ? literal(init.get("method")) : "GET";
  if (method === undefined) {
    return undefined;
  }
  return {
    source,
    method: method.toUpperCase(),
    path: new URL(url).pathname,
  };
};

type EvidenceMaps = {
  handlers: Map<string, Set<string>>;
  http: Map<string, Set<string>>;
  mcp: Map<string, Set<string>>;
  unresolvedCalls: ConformanceTestEvidence["unresolvedCalls"];
};

const recordBinding = (
  name: ts.BindingName,
  declarations: Map<string, number>,
) => {
  if (ts.isIdentifier(name)) {
    declarations.set(name.text, (declarations.get(name.text) ?? 0) + 1);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      recordBinding(element.name, declarations);
    }
  }
};

const collectSourceEvidence = (
  { file, source: sourceText }: ConformanceTestSource,
  { handlers, http, mcp, unresolvedCalls }: EvidenceMaps,
) => {
  const tree = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const endpoints = new Map<string, string>();
  const dispatchers = new Set<string>();
  const apps = new Map<string, "composed-api" | "standalone-app">();
  const constructors = new Set<string>();
  const declarations = new Map<string, number>();
  const inspect = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      if (
        clause === undefined ||
        clause.phaseModifier === ts.SyntaxKind.TypeKeyword
      ) {
        return;
      }
      const owner = modulePath(file, node.moduleSpecifier.text);
      const register = (local: string, exported: string) => {
        declarations.set(local, (declarations.get(local) ?? 0) + 1);
        if (owner.startsWith("apps/api/src/handlers/")) {
          endpoints.set(
            local,
            `${owner}.ts${exported === "default" ? "" : `#${exported}`}`,
          );
        }
        if (
          owner === "apps/api/src/mcp/tools" &&
          exported === "handleMcpToolCall"
        ) {
          dispatchers.add(local);
        }
        if (owner === "apps/api/src/server" && exported === "default") {
          apps.set(local, "composed-api");
        }
        if (
          owner === "elysia" &&
          (exported === "default" || exported === "Elysia")
        ) {
          constructors.add(local);
        }
      };
      if (clause.name !== undefined) {
        register(clause.name.text, "default");
      }
      if (
        clause.namedBindings !== undefined &&
        ts.isNamespaceImport(clause.namedBindings)
      ) {
        recordBinding(clause.namedBindings.name, declarations);
      }
      if (
        clause.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings)
      ) {
        for (const binding of clause.namedBindings.elements) {
          if (!binding.isTypeOnly) {
            register(
              binding.name.text,
              binding.propertyName?.text ?? binding.name.text,
            );
          }
        }
      }
    }
    // Binding elements are counted by their containing declaration.
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      recordBinding(node.name, declarations);
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name !== undefined
    ) {
      recordBinding(node.name, declarations);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(tree);
  const unique = (name: string) => declarations.get(name) === 1;
  const discoverApps = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isNewExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      constructors.has(node.initializer.expression.text) &&
      unique(node.initializer.expression.text)
    ) {
      apps.set(node.name.text, "standalone-app");
    }
    ts.forEachChild(node, discoverApps);
  };
  discoverApps(tree);
  const globalAvailable = (name: string) => !declarations.has(name);
  const recordHandlerCall = (node: ts.CallExpression) => {
    const property = member(node.expression);
    if (
      (property?.name === "handler" || property?.name === undefined) &&
      property !== undefined &&
      ts.isIdentifier(property.receiver) &&
      endpoints.has(property.receiver.text)
    ) {
      const endpoint = endpoints.get(property.receiver.text);
      if (
        endpoint !== undefined &&
        property.name === "handler" &&
        unique(property.receiver.text)
      ) {
        add(handlers, endpoint, file);
      } else {
        unresolvedCalls.handler += 1;
      }
    }
  };
  const recordMcpCall = (node: ts.CallExpression) => {
    const callee = node.expression;
    if (ts.isIdentifier(callee) && dispatchers.has(callee.text)) {
      const input = fields(node.arguments.at(0));
      const name = literal(input?.get("toolName"));
      const mode = input?.has("mode") ? literal(input.get("mode")) : "default";
      if (
        unique(callee.text) &&
        input !== undefined &&
        name !== undefined &&
        mode !== undefined
      ) {
        add(mcp, JSON.stringify([mode, name]), file);
      } else {
        unresolvedCalls.mcp += 1;
      }
    }
  };
  const recordHttpCall = (node: ts.CallExpression) => {
    const callee = node.expression;
    const property = member(callee);
    const fetchCall = ts.isIdentifier(callee) && callee.text === "fetch";
    if (fetchCall || property?.name === "handle") {
      let target;
      if (fetchCall && globalAvailable("fetch")) {
        target = request(node.arguments, "fetch");
      }
      if (
        property?.name === "handle" &&
        ts.isIdentifier(property.receiver) &&
        apps.has(property.receiver.text) &&
        unique(property.receiver.text)
      ) {
        const source = apps.get(property.receiver.text);
        const argument = node.arguments.at(0);
        if (
          source !== undefined &&
          argument !== undefined &&
          ts.isNewExpression(argument) &&
          ts.isIdentifier(argument.expression) &&
          argument.expression.text === "Request" &&
          globalAvailable("Request")
        ) {
          target = request(argument.arguments ?? [], source);
        }
      }
      if (target === undefined) {
        unresolvedCalls.http += 1;
      } else {
        add(
          http,
          JSON.stringify([target.source, target.method, target.path]),
          file,
        );
      }
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isTypeNode(node)) {
      return;
    }
    if (ts.isCallExpression(node)) {
      recordHandlerCall(node);
      recordMcpCall(node);
      recordHttpCall(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
};

/**
 * Conservative source evidence, deliberately separate from executed coverage.
 * Indirect calls, interpolated URLs and shadowed bindings remain unresolved.
 */
export const collectConformanceTestEvidence = (
  sources: readonly ConformanceTestSource[],
): ConformanceTestEvidence => {
  const handlers = new Map<string, Set<string>>();
  const http = new Map<string, Set<string>>();
  const mcp = new Map<string, Set<string>>();
  const unresolvedCalls = { handler: 0, http: 0, mcp: 0 };
  for (const source of sources) {
    collectSourceEvidence(source, { handlers, http, mcp, unresolvedCalls });
  }
  const entries = (map: Map<string, Set<string>>) =>
    [...map].toSorted(([a], [b]) => {
      if (a < b) {
        return -1;
      }
      if (a > b) {
        return 1;
      }
      return 0;
    });
  const pair = (key: string): [string, string] => {
    const value: unknown = JSON.parse(key);
    if (
      !Array.isArray(value) ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string" ||
      value.length !== 2
    ) {
      return panic("Conformance evidence lost its pair key");
    }
    return [value[0], value[1]];
  };
  return {
    handlerCalls: entries(handlers).map(([endpoint, tests]) => ({
      endpoint,
      tests: [...tests].toSorted(),
    })),
    httpCalls: entries(http).map(([key, tests]) => {
      const value: unknown = JSON.parse(key);
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        (value[0] !== "composed-api" &&
          value[0] !== "standalone-app" &&
          value[0] !== "fetch") ||
        typeof value[1] !== "string" ||
        typeof value[2] !== "string"
      ) {
        return panic("Conformance evidence lost its HTTP key");
      }
      return {
        source: value[0],
        method: value[1],
        path: value[2],
        tests: [...tests].toSorted(),
      };
    }),
    mcpCalls: entries(mcp).map(([key, tests]) => {
      const [mode, name] = pair(key);
      return { mode, name, tests: [...tests].toSorted() };
    }),
    unresolvedCalls,
  };
};
