import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

import { compareCodeUnit } from "@stll/collation";
import { sourceFileIndex } from "@stll/scripts/src/source-file-index";

import { REPLAY_CAPABLE_ROUTES } from "@/lib/idempotency/replay-routes.gen";

import {
  createRouteInventory,
  liveCreateRouteRows,
} from "../../tests/helpers/idempotent-create-route-census";

const sourceRoot = path.resolve(import.meta.dirname, "..");
type ParseOptions = { file: string; text: string };
const parse = ({ file, text }: ParseOptions) =>
  ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
const walk = (node: ts.Node, visit: (node: ts.Node) => void) => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};
// Parsed nodes have parents up to the SourceFile; its typed parent is not
// optional even though it is absent at runtime.
const ancestorsOf = (node: ts.Node) => {
  const ancestors = [node];
  let ancestor = node;
  while (!ts.isSourceFile(ancestor)) {
    ancestor = ancestor.parent;
    ancestors.push(ancestor);
  }
  return ancestors;
};

type ClientEnvironment = {
  declarations: Map<string, ts.Expression>;
  roots: ReadonlyMap<string, readonly string[]>;
};

type ClientPathOptions = {
  node: ts.Expression;
  environment: ClientEnvironment;
  seen?: Set<string>;
};
const clientPath = ({
  node,
  environment,
  seen = new Set<string>(),
}: ClientPathOptions): readonly string[] | undefined => {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return clientPath({ node: node.expression, environment, seen });
  }
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) {
      return undefined;
    }
    const declaration = environment.declarations.get(node.text);
    if (declaration) {
      seen.add(node.text);
      return clientPath({ node: declaration, environment, seen });
    }
    return environment.roots.get(node.text);
  }
  if (ts.isArrowFunction(node)) {
    if (!ts.isBlock(node.body)) {
      return clientPath({ node: node.body, environment, seen });
    }
    const returned = node.body.statements.find(
      ts.isReturnStatement,
    )?.expression;
    return returned
      ? clientPath({ node: returned, environment, seen })
      : undefined;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const parent = clientPath({ node: node.expression, environment, seen });
    return parent ? [...parent, node.name.text] : undefined;
  }
  if (ts.isElementAccessExpression(node)) {
    const parent = clientPath({ node: node.expression, environment, seen });
    return parent
      ? [
          ...parent,
          ts.isStringLiteral(node.argumentExpression)
            ? node.argumentExpression.text
            : "*",
        ]
      : undefined;
  }
  if (!ts.isCallExpression(node)) {
    return undefined;
  }
  if (
    ts.isIdentifier(node.expression) &&
    node.expression.text === "createApiClient"
  ) {
    return [];
  }
  const parent = clientPath({ node: node.expression, environment, seen });
  if (!parent) {
    return undefined;
  }
  if (
    ts.isIdentifier(node.expression) &&
    environment.declarations.get(node.expression.text)?.kind ===
      ts.SyntaxKind.ArrowFunction
  ) {
    return parent;
  }
  let args = node.arguments.at(0);
  const argumentAliases = new Set<string>();
  while (args) {
    if (
      ts.isParenthesizedExpression(args) ||
      ts.isAsExpression(args) ||
      ts.isSatisfiesExpression(args)
    ) {
      args = args.expression;
      continue;
    }
    if (!ts.isIdentifier(args)) {
      break;
    }
    if (argumentAliases.has(args.text)) {
      return undefined;
    }
    argumentAliases.add(args.text);
    args = environment.declarations.get(args.text);
  }
  if (!args || !ts.isObjectLiteralExpression(args)) {
    return undefined;
  }
  return [...parent, ...args.properties.map(() => "*")];
};

const declarationsIn = (tree: ts.SourceFile) => {
  const declarations = new Map<string, ts.Expression>();
  walk(tree, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      declarations.set(node.name.text, node.initializer);
    }
  });
  return declarations;
};

// Client entry paths come from the same native client exports used by the UI.
const clientRoots = () => {
  const tree = parse({
    file: "api.ts",
    text: readFileSync(path.join(sourceRoot, "lib/api.ts"), "utf-8"),
  });
  const declarations = declarationsIn(tree);
  const roots = new Map<string, readonly string[]>();
  for (const [name, expression] of declarations) {
    const route = clientPath({
      node: expression,
      environment: { declarations, roots: new Map() },
    });
    if (route) {
      roots.set(name, route.at(0) === "v1" ? route.slice(1) : route);
    }
  }
  return roots;
};

type CreateMutationViolationsOptions = {
  file: string;
  text: string;
  creates: ReadonlySet<string>;
  roots?: ReadonlyMap<string, readonly string[]>;
};
const createMutationViolations = ({
  file,
  text,
  creates,
  roots = new Map([["api", []]]),
}: CreateMutationViolationsOptions) => {
  const tree = parse({ file, text });
  const environment = {
    declarations: declarationsIn(tree),
    roots: new Map(roots),
  };
  const scopedDeclarations = new Map<ts.Node, Map<string, ts.Expression>>();
  walk(tree, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.initializer
    ) {
      return;
    }
    let scope: ts.Node = node;
    while (!ts.isBlock(scope) && !ts.isSourceFile(scope)) {
      scope = scope.parent;
    }
    let declarations = scopedDeclarations.get(scope);
    if (!declarations) {
      declarations = new Map();
      scopedDeclarations.set(scope, declarations);
    }
    declarations.set(node.name.text, node.initializer);
  });
  const declarationsAt = (node: ts.Node) => {
    const scopes: Map<string, ts.Expression>[] = [];
    for (const ancestor of ancestorsOf(node)) {
      const declarations = scopedDeclarations.get(ancestor);
      if (declarations) {
        scopes.push(declarations);
      }
    }
    const declarations = new Map<string, ts.Expression>();
    for (const scope of scopes.toReversed()) {
      for (const [name, initializer] of scope) {
        declarations.set(name, initializer);
      }
    }
    return declarations;
  };
  const factories = new Map<
    string,
    "submit" | "mutation" | "intent" | "category"
  >();
  const requestTypes = new Set<string>();
  const derivedRequests = new Set<string>();
  const typeAliases = new Map<string, ts.TypeNode>();
  type ModuleOwnerOptions = { module: string; owner: string };
  const isModule = ({ module, owner }: ModuleOwnerOptions) => {
    if (module.startsWith("@/")) {
      return (
        path.resolve(sourceRoot, module.slice(2)) ===
        path.resolve(sourceRoot, owner)
      );
    }
    if (module.startsWith(".")) {
      return (
        path.resolve(sourceRoot, path.dirname(file), module) ===
        path.resolve(sourceRoot, owner)
      );
    }
    return false;
  };
  for (const statement of tree.statements) {
    if (ts.isTypeAliasDeclaration(statement)) {
      typeAliases.set(statement.name.text, statement.type);
    }
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    const module = statement.moduleSpecifier.text;
    for (const binding of bindings.elements) {
      const name = (binding.propertyName ?? binding.name).text;
      if (
        isModule({
          module,
          owner: "routes/knowledge/-components/category-sidebar",
        }) &&
        name === "useCategoryOps"
      ) {
        factories.set(binding.name.text, "category");
      }
      if (
        isModule({ module, owner: "lib/idempotency/idempotent-subrequest" }) &&
        name === "deriveIdempotentRequest"
      ) {
        derivedRequests.add(binding.name.text);
      }
      const root = roots.get(name);
      if (isModule({ module, owner: "lib/api" }) && root) {
        environment.roots.set(binding.name.text, root);
      }
      if (
        isModule({
          module,
          owner: "lib/idempotency/idempotent-submit.logic",
        }) &&
        name === "createSubmitIntent"
      ) {
        factories.set(binding.name.text, "intent");
      }
      if (
        isModule({ module, owner: "lib/idempotency/use-idempotent-submit" })
      ) {
        if (name === "useIdempotentSubmit") {
          factories.set(binding.name.text, "submit");
        }
        if (name === "IdempotentRequest") {
          requestTypes.add(binding.name.text);
        }
      }
      if (
        (isModule({
          module,
          owner: "lib/idempotency/use-idempotent-mutation",
        }) &&
          name === "useIdempotentMutation") ||
        (isModule({
          module,
          owner: "routes/_protected.admin/-hooks/use-settings-mutation",
        }) &&
          name === "useSettingsMutation") ||
        (isModule({
          module,
          owner: "lib/capabilities/use-capability-mutation",
        }) &&
          name === "useCapabilityMutation")
      ) {
        factories.set(binding.name.text, "mutation");
      }
    }
  }
  const parameterBindingType = (
    parameter: ts.ParameterDeclaration,
    name: string,
  ) => {
    if (ts.isIdentifier(parameter.name)) {
      return parameter.name.text === name ? parameter.type : undefined;
    }
    if (!ts.isObjectBindingPattern(parameter.name) || !parameter.type) {
      return undefined;
    }
    const binding = parameter.name.elements.find(
      (entry) => ts.isIdentifier(entry.name) && entry.name.text === name,
    );
    if (!binding) {
      return undefined;
    }
    const type =
      ts.isTypeReferenceNode(parameter.type) &&
      ts.isIdentifier(parameter.type.typeName)
        ? typeAliases.get(parameter.type.typeName.text)
        : parameter.type;
    if (!type || !ts.isTypeLiteralNode(type)) {
      return undefined;
    }
    const key = (binding.propertyName ?? binding.name).getText(tree);
    return type.members.find(
      (entry): entry is ts.PropertySignature =>
        ts.isPropertySignature(entry) &&
        ts.isIdentifier(entry.name) &&
        entry.name.text === key,
    )?.type;
  };
  const ownedRun = (node: ts.Node): boolean => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "run" ||
      !ts.isIdentifier(node.expression.expression)
    ) {
      return false;
    }
    const name = node.expression.expression.text;
    for (const ancestor of ancestorsOf(node)) {
      const receiver = scopedDeclarations.get(ancestor)?.get(name);
      if (receiver) {
        return (
          ts.isCallExpression(receiver) &&
          ts.isIdentifier(receiver.expression) &&
          factories.get(receiver.expression.text) === "submit"
        );
      }
      if (
        ts.isArrowFunction(ancestor) ||
        ts.isFunctionExpression(ancestor) ||
        ts.isFunctionDeclaration(ancestor)
      ) {
        for (const parameter of ancestor.parameters) {
          const type = parameterBindingType(parameter, name);
          if (
            !type ||
            !ts.isTypeReferenceNode(type) ||
            !ts.isIdentifier(type.typeName) ||
            type.typeName.text !== "ReturnType"
          ) {
            continue;
          }
          const query = type.typeArguments?.at(0);
          if (
            query &&
            ts.isTypeQueryNode(query) &&
            ts.isIdentifier(query.exprName) &&
            factories.get(query.exprName.text) === "submit"
          ) {
            return true;
          }
        }
      }
    }
    return false;
  };
  const ownedCallback = (
    node: ts.ArrowFunction | ts.FunctionExpression,
  ): boolean => {
    const assignment = node.parent;
    if (
      !ts.isPropertyAssignment(assignment) ||
      !ts.isIdentifier(assignment.name) ||
      !ts.isObjectLiteralExpression(assignment.parent)
    ) {
      return false;
    }
    const call = assignment.parent.parent;
    if (!ts.isCallExpression(call)) {
      return false;
    }
    if (assignment.name.text === "send") {
      return ownedRun(call);
    }
    if (!ts.isIdentifier(call.expression)) {
      return false;
    }
    const factory = factories.get(call.expression.text);
    return (
      (assignment.name.text === "mutationFn" && factory === "mutation") ||
      (assignment.name.text === "create" && factory === "category")
    );
  };
  const requestType = (type: ts.TypeNode | undefined): boolean =>
    type !== undefined &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    requestTypes.has(type.typeName.text);
  const parameterOwns = (
    parameter: ts.ParameterDeclaration,
    name: string,
  ): boolean => requestType(parameterBindingType(parameter, name));
  const requestIdentifier = (name: string, node: ts.Node): boolean => {
    for (const ancestor of ancestorsOf(node)) {
      const initializer = scopedDeclarations.get(ancestor)?.get(name);
      if (initializer) {
        if (
          !ts.isCallExpression(initializer) ||
          !ts.isPropertyAccessExpression(initializer.expression) ||
          initializer.expression.name.text !== "request" ||
          !ts.isIdentifier(initializer.expression.expression)
        ) {
          return false;
        }
        const intent = declarationsAt(initializer).get(
          initializer.expression.expression.text,
        );
        return (
          intent !== undefined &&
          ts.isCallExpression(intent) &&
          ts.isIdentifier(intent.expression) &&
          factories.get(intent.expression.text) === "intent"
        );
      }
      if (
        ts.isArrowFunction(ancestor) ||
        ts.isFunctionExpression(ancestor) ||
        ts.isFunctionDeclaration(ancestor)
      ) {
        const parameter = ancestor.parameters.find((entry) =>
          ts.isIdentifier(entry.name)
            ? entry.name.text === name
            : ts.isObjectBindingPattern(entry.name) &&
              entry.name.elements.some(
                (binding) =>
                  ts.isIdentifier(binding.name) && binding.name.text === name,
              ),
        );
        if (parameter) {
          if (parameterOwns(parameter, name)) {
            return true;
          }
          return (
            ancestor.parameters.at(1) === parameter &&
            !ts.isFunctionDeclaration(ancestor) &&
            ownedCallback(ancestor)
          );
        }
      }
    }
    return false;
  };
  const requestOptions = (
    node: ts.Expression | undefined,
    at: ts.Node,
  ): boolean => {
    if (!node) {
      return false;
    }
    if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) {
      return requestOptions(node.expression, at);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      derivedRequests.has(node.expression.text)
    ) {
      return requestOptions(node.arguments.at(0), at);
    }
    if (ts.isIdentifier(node)) {
      return requestIdentifier(node.text, at);
    }
    if (!ts.isObjectLiteralExpression(node)) {
      return false;
    }
    for (const entry of node.properties) {
      if (
        ts.isPropertyAssignment(entry) &&
        ts.isIdentifier(entry.name) &&
        entry.name.text === "fetch" &&
        requestOptions(entry.initializer, at)
      ) {
        return true;
      }
      if (
        ts.isSpreadAssignment(entry) &&
        ts.isIdentifier(entry.expression) &&
        requestIdentifier(entry.expression.text, at)
      ) {
        return true;
      }
      if (
        !ts.isPropertyAssignment(entry) ||
        !ts.isIdentifier(entry.name) ||
        entry.name.text !== "headers"
      ) {
        continue;
      }
      const headers = entry.initializer;
      if (
        ts.isPropertyAccessExpression(headers) &&
        headers.name.text === "headers" &&
        requestOptions(headers.expression, at)
      ) {
        return true;
      }
    }
    return false;
  };
  const violations: string[] = [];
  let createCalls = 0;
  walk(tree, (node) => {
    if (
      !ts.isPropertyAccessExpression(node) ||
      (node.name.text !== "put" && node.name.text !== "post")
    ) {
      return;
    }
    for (const ancestor of ancestorsOf(node.parent)) {
      if (ts.isTypeNode(ancestor)) {
        return;
      }
    }
    const route = clientPath({
      node: node.expression,
      environment: {
        declarations: declarationsAt(node),
        roots: environment.roots,
      },
    });
    if (!route || !creates.has(`${node.name.text}:${route.join("/")}`)) {
      return;
    }
    createCalls += 1;
    const call = node.parent;
    let protectedCall =
      ts.isCallExpression(call) &&
      call.expression === node &&
      requestOptions(call.arguments.at(1), node);
    if (
      ts.isPropertyAssignment(call) &&
      ts.isIdentifier(call.name) &&
      call.name.text === "send" &&
      ts.isObjectLiteralExpression(call.parent)
    ) {
      protectedCall = ownedRun(call.parent.parent);
    }
    if (!protectedCall) {
      const position = tree.getLineAndCharacterOfPosition(node.getStart(tree));
      violations.push(
        `${file}:${position.line + 1}: ${node.name.text}:${route.join("/")} needs submit-intent headers`,
      );
    }
  });
  return { createCalls, violations };
};

// timeout: Parsing the full server and browser source inventories is CPU-bound.
test("every web call to a registered JSON create route carries submit-intent headers", () => {
  const liveRoutes = liveCreateRouteRows();
  const { all, replay: creates, excluded } = createRouteInventory(liveRoutes);
  const replayRoutes = liveRoutes
    .filter(({ replay }) => replay)
    .map(({ method, path: routePath }) => ({ method, path: routePath }));
  const routeIdentity = ({
    method,
    path: routePath,
  }: {
    method: string;
    path: string;
  }) => `${method} ${routePath}`;
  expect(replayRoutes.length).toBeGreaterThan(0);
  expect(
    replayRoutes.toSorted((left, right) =>
      compareCodeUnit(routeIdentity(left), routeIdentity(right)),
    ),
  ).toEqual(
    REPLAY_CAPABLE_ROUTES.toSorted((left, right) =>
      compareCodeUnit(routeIdentity(left), routeIdentity(right)),
    ),
  );
  expect(new Set(REPLAY_CAPABLE_ROUTES.map(routeIdentity)).size).toBe(
    REPLAY_CAPABLE_ROUTES.length,
  );
  const replayIdentities = new Set(REPLAY_CAPABLE_ROUTES.map(routeIdentity));
  expect(
    liveRoutes
      .filter(({ replay }) => !replay)
      .filter((route) => replayIdentities.has(routeIdentity(route))),
  ).toEqual([]);
  expect(all.size).toBeGreaterThan(75);
  expect(creates.size + excluded.size).toBe(all.size);
  expect([...creates].filter((route) => excluded.has(route))).toEqual([]);
  const violations: string[] = [];
  const roots = clientRoots();
  let createCalls = 0;
  for (const { relativePath: file, sourceText: text } of sourceFileIndex(
    sourceRoot,
  )) {
    if (/\.(?:test|type-test)\./u.test(file)) {
      continue;
    }
    if (!/\.(?:put|post)\b/u.test(text)) {
      continue;
    }
    const result = createMutationViolations({ file, text, creates, roots });
    createCalls += result.createCalls;
    violations.push(...result.violations);
  }
  expect(createCalls).toBeGreaterThan(50);
  expect(violations).toEqual([]);
}, 15_000);

test("create census rejects unrelated options and includes unnamed component actions", () => {
  const routes = new Set(["post:things/*/items", "put:things"]);
  const source = `
    import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
    const onSave = () => api.things({ id }).items.post(body, { fetch: { signal } });
    const onCreate = () => api.things.put(body, {});
    const submit = useIdempotentSubmit();
    submit.run({ body, operation: "create", send: (body, request) => api.things.put(body, request) });
  `;
  expect(
    createMutationViolations({
      file: "component.tsx",
      text: source,
      creates: routes,
    }),
  ).toEqual({
    createCalls: 3,
    violations: expect.arrayContaining([
      expect.stringContaining("post:things/*/items"),
      expect.stringContaining("put:things"),
    ]),
  });
  expect(
    createMutationViolations({
      file: "component.tsx",
      text: source,
      creates: routes,
    }).violations,
  ).toHaveLength(2);
});

test("create census follows client aliases, dynamic IDs and owned method references", () => {
  const routes = new Set([
    "post:things/*/items",
    "post:signals/*/assignments",
    "post:memories",
  ]);
  const source = `
    import { useIdempotentSubmit as useSubmit } from "@/lib/idempotency/use-idempotent-submit";
    import type { IdempotentRequest } from "@/lib/idempotency/use-idempotent-submit";
    const submit = useSubmit();
    const listApi = api.things({ matterId: dynamicId });
    const signalClient = (id: string) => api.signals({ signalId: id });
    submit.run({ body, operation: "item", send: listApi.items.post });
    submit.run({ body, operation: "signal", send: (body, request) => signalClient(dynamicId).assignments.post(body, { headers: request.headers }) });
    const createMemory = (body: unknown, request: IdempotentRequest) => memoriesApi.post(body, request);
  `;
  expect(
    createMutationViolations({
      file: "component.tsx",
      text: source,
      creates: routes,
      roots: new Map([
        ["api", []],
        ["memoriesApi", ["memories"]],
      ]),
    }),
  ).toEqual({ createCalls: 3, violations: [] });
});

test("create census rejects bogus request names, static keys and unowned method references", () => {
  const source = `
    import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
    api.things.put(body, request);
    api.things.put(body, { headers: { "Idempotency-Key": "constant" } });
    const arbitrary = { send: api.things.put };
    unrelated.run({ send: api.things.put });
  `;
  const result = createMutationViolations({
    file: "fixture.ts",
    text: source,
    creates: new Set(["put:things"]),
  });
  expect(result.createCalls).toBe(4);
  expect(result.violations).toHaveLength(4);
});

test("create census recognizes owned fetch headers beside capability options", () => {
  const source = `
    import type { IdempotentRequest } from "@/lib/idempotency/use-idempotent-submit";
    const create = (body: unknown, intent: IdempotentRequest) =>
      api.things.put(body, { ...capability, fetch: { headers: intent.headers } });
    const unowned = () =>
      api.things.put(body, { ...capability, fetch: { headers: request.headers } });
  `;
  const result = createMutationViolations({
    file: "fixture.ts",
    text: source,
    creates: new Set(["put:things"]),
  });
  expect(result.createCalls).toBe(2);
  expect(result.violations).toHaveLength(1);
  expect(result.violations.at(0)).toContain("fixture.ts:6:");
});

test("create census recognizes the plain submit-intent owner and aliased client imports", () => {
  const source = `
    import { api as client } from "@/lib/api";
    import { createSubmitIntent } from "@/lib/idempotency/idempotent-submit.logic";
    const intent = createSubmitIntent(createUuid);
    const request = intent.request();
    client.things.put(body, request);
  `;
  expect(
    createMutationViolations({
      file: "fixture.ts",
      text: source,
      creates: new Set(["put:things"]),
    }),
  ).toEqual({ createCalls: 1, violations: [] });
});

test("create census keeps request-owner aliases inside their lexical scope", () => {
  const source = `
    import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
    function unowned() {
      const submit = unrelated();
      submit.run({ send: api.things.put });
    }
    function owned() {
      const submit = useIdempotentSubmit();
      submit.run({ send: api.things.put });
    }
  `;
  const result = createMutationViolations({
    file: "fixture.ts",
    text: source,
    creates: new Set(["put:things"]),
  });
  expect(result.createCalls).toBe(2);
  expect(result.violations).toHaveLength(1);
});

test("create census refuses a request parameter that shadows an owned request", () => {
  const source = `
    import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
    const submit = useIdempotentSubmit();
    submit.run({ send: (body, request) => {
      const unowned = (request: unknown) => api.things.put(body, request);
      return api.things.put(body, request);
    } });
  `;
  const result = createMutationViolations({
    file: "fixture.ts",
    text: source,
    creates: new Set(["put:things"]),
  });
  expect(result.createCalls).toBe(2);
  expect(result.violations).toHaveLength(1);
});

test("create census recognizes a helper parameter typed by the submit owner", () => {
  const source = `
    import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
    type Args = { submit: ReturnType<typeof useIdempotentSubmit> };
    const create = ({ submit }: Args) => submit.run({ body, send: api.things.put });
  `;
  expect(
    createMutationViolations({
      file: "fixture.ts",
      text: source,
      creates: new Set(["put:things"]),
    }),
  ).toEqual({ createCalls: 1, violations: [] });
});

test("create census follows the owned subrequest derivation and rejects an unowned parent", () => {
  const source = `
    import { deriveIdempotentRequest } from "@/lib/idempotency/idempotent-subrequest";
    import type { IdempotentRequest } from "@/lib/idempotency/use-idempotent-submit";
    const protectedCreate = async (request: IdempotentRequest) => api.things.put(body, await deriveIdempotentRequest(request, "child"));
    const unownedCreate = async () => api.things.put(body, await deriveIdempotentRequest(request, "child"));
  `;
  const result = createMutationViolations({
    file: "fixture.ts",
    text: source,
    creates: new Set(["put:things"]),
  });
  expect(result.createCalls).toBe(2);
  expect(result.violations).toHaveLength(1);
});

test("create census trusts owning mutation wrappers and refuses unrelated matching names", () => {
  const source = `
    import { useCapabilityMutation } from "@/lib/capabilities/use-capability-mutation";
    import { useSettingsMutation } from "@/routes/_protected.admin/-hooks/use-settings-mutation";
    import { useIdempotentMutation } from "@/unrelated/use-idempotent-mutation";
    useCapabilityMutation({ mutationFn: (body, request) => api.things.put(body, request) });
    useSettingsMutation({ mutationFn: (body, request) => api.things.put(body, request) });
    useIdempotentMutation({ mutationFn: (body, request) => api.things.put(body, request) });
  `;
  const result = createMutationViolations({
    file: "fixture.ts",
    text: source,
    creates: new Set(["put:things"]),
  });
  expect(result.createCalls).toBe(3);
  expect(result.violations).toHaveLength(1);
});

test("create census recognizes only the category callback supplied by its owning hook", () => {
  const source = `
    import { useCategoryOps as useCategories } from "./category-sidebar";
    import { useCategoryOps } from "@/unrelated/category-sidebar";
    useCategories({ create: (name, request) => api.things.put({ name }, request) });
    useCategoryOps({ create: (name, request) => api.things.put({ name }, request) });
  `;
  const result = createMutationViolations({
    file: "routes/knowledge/-components/fixture.tsx",
    text: source,
    creates: new Set(["put:things"]),
  });
  expect(result.createCalls).toBe(2);
  expect(result.violations).toHaveLength(1);
});

test("create census resolves lexically scoped parameter-object aliases", () => {
  const source = `
    import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
    const submit = useIdempotentSubmit();
    function sample() {
      const scope = { workspaceId: dynamicId };
      const alias = scope;
      api.tasks(alias).put(body, {});
      api.lists(scope).put(body);
      submit.run({ body, operation: "task", send: api.tasks(alias).put });
    }
    function nested() {
      const scope = { workspaceId: dynamicId, entityId: anotherId };
      api.tasks(scope).put(body);
    }
  `;
  const result = createMutationViolations({
    file: "fixture.ts",
    text: source,
    creates: new Set(["put:tasks/*", "put:lists/*", "put:tasks/*/*"]),
  });
  expect(result.createCalls).toBe(4);
  expect(result.violations).toHaveLength(3);
});

test("create census projects mounted native routes into browser paths and replay policies", () => {
  const inventory = createRouteInventory([
    {
      method: "POST",
      path: "/v1/things/:thingId/items",
      file: "src/handlers/items/create.ts",
      replay: true,
    },
    {
      method: "PUT",
      path: "/v1/upload/:workspaceId",
      file: "src/handlers/upload/create.ts",
      replay: false,
    },
  ]);
  expect([...inventory.all].toSorted()).toEqual([
    "post:things/*/items",
    "put:upload/*",
  ]);
  expect([...inventory.replay]).toEqual(["post:things/*/items"]);
  expect([...inventory.excluded]).toEqual(["put:upload/*"]);
});

const usesGeneratedReplayPolicy = (text: string): boolean => {
  const tree = parse({ file: "api.ts", text });
  const imports = tree.statements.filter(ts.isImportDeclaration);
  const generated = imports.find(
    (statement) =>
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@/lib/idempotency/replay-routes.gen",
  );
  const bindings = generated?.importClause?.namedBindings;
  const replayImport =
    bindings && ts.isNamedImports(bindings)
      ? bindings.elements.find(
          (binding) =>
            (binding.propertyName ?? binding.name).text ===
            "REPLAY_CAPABLE_ROUTES",
        )?.name.text
      : undefined;
  if (replayImport === undefined) {
    return false;
  }
  const declarations = tree.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations]);
  const options = declarations.find(
    (declaration) =>
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === "webApiClientOptions",
  );
  let value = options?.initializer;
  while (
    value &&
    (ts.isSatisfiesExpression(value) ||
      ts.isAsExpression(value) ||
      ts.isParenthesizedExpression(value))
  ) {
    value = value.expression;
  }
  if (
    !value ||
    !ts.isObjectLiteralExpression(value) ||
    value.properties.some(ts.isSpreadAssignment)
  ) {
    return false;
  }
  const policies = value.properties.filter(
    (property) =>
      ts.isPropertyAssignment(property) &&
      property.name.getText(tree) === "requestReplayRoutes",
  );
  const policy = policies.at(0);
  if (
    policies.length !== 1 ||
    !policy ||
    !ts.isPropertyAssignment(policy) ||
    !ts.isIdentifier(policy.initializer) ||
    policy.initializer.text !== replayImport
  ) {
    return false;
  }
  const client = declarations.find(
    (declaration) =>
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === "apiClient",
  )?.initializer;
  return (
    client !== undefined &&
    ts.isCallExpression(client) &&
    ts.isIdentifier(client.expression) &&
    client.expression.text === "createApiClient" &&
    client.arguments.at(1)?.getText(tree) === "webApiClientOptions"
  );
};

test("the central browser client installs the generated mounted replay policy", () => {
  expect(
    usesGeneratedReplayPolicy(
      readFileSync(path.join(sourceRoot, "lib/api.ts"), "utf-8"),
    ),
  ).toBe(true);
});

test("replay policy census rejects missing, unrelated, overridden and uninstalled browser policies", () => {
  const source = `
    import { REPLAY_CAPABLE_ROUTES as replayRoutes } from "@/lib/idempotency/replay-routes.gen";
    export const webApiClientOptions = { requestReplayRoutes: replayRoutes } satisfies ApiClientOptions;
    export const apiClient = createApiClient<WebRoutes>(baseUrl, webApiClientOptions);
  `;
  expect(usesGeneratedReplayPolicy(source)).toBe(true);
  for (const mutation of [
    source.replace("requestReplayRoutes: replayRoutes", ""),
    source.replace(
      "requestReplayRoutes: replayRoutes",
      "requestReplayRoutes: unrelated",
    ),
    source.replace(
      "requestReplayRoutes: replayRoutes",
      "requestReplayRoutes: []",
    ),
    source.replace(
      "requestReplayRoutes: replayRoutes",
      "requestReplayRoutes: replayRoutes, ...unrelated",
    ),
    source.replace("baseUrl, webApiClientOptions", "baseUrl, unrelated"),
    source.replace("@/lib/idempotency/replay-routes.gen", "@/unrelated"),
  ]) {
    expect(usesGeneratedReplayPolicy(mutation)).toBe(false);
  }
});
