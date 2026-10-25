import {
  type IdentifierNode as Identifier,
  type Node,
  type ObjectExpression,
  parseSource,
  type Program,
  walk,
} from "./syntax-tree";

const BUN_TIMEOUT_APIS = new Set([
  "afterAll",
  "afterEach",
  "beforeAll",
  "beforeEach",
  "it",
  "setDefaultTimeout",
  "test",
]);
const BUN_JEST_BINDING = "jest";

const rootIdentifier = (expression: Node): Identifier | undefined => {
  if (expression.type === "Identifier") {
    return expression;
  }
  if (expression.type === "MemberExpression") {
    return rootIdentifier(expression.object);
  }
  if (expression.type === "CallExpression") {
    return rootIdentifier(expression.callee);
  }
  return undefined;
};

const isPropertyTestTimeoutCall = (expression: Node): boolean =>
  expression.type === "CallExpression" &&
  expression.callee.type === "Identifier" &&
  expression.callee.name === "propertyTestTimeout";

const propertyName = (name: Node): string | undefined => {
  if (name.type === "Identifier") {
    return name.name;
  }
  if (name.type === "Literal" && typeof name.value === "string") {
    return name.value;
  }
  return undefined;
};

type BunTestBindings = {
  named: Map<string, string>;
  namespaces: Set<string>;
};

const bunTestBindings = (sourceFile: Program): BunTestBindings => {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of sourceFile.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.source.value !== "bun:test"
    ) {
      continue;
    }
    for (const element of statement.specifiers) {
      if (element.type === "ImportNamespaceSpecifier") {
        namespaces.add(element.local.name);
        continue;
      }
      if (element.type !== "ImportSpecifier") {
        continue;
      }
      const importedName = propertyName(element.imported);
      if (
        importedName !== undefined &&
        (BUN_TIMEOUT_APIS.has(importedName) ||
          importedName === BUN_JEST_BINDING)
      ) {
        named.set(element.local.name, importedName);
      }
    }
  }
  return { named, namespaces };
};

const memberPath = (expression: Node, root: string): string[] | undefined => {
  if (expression.type === "Identifier") {
    return expression.name === root ? [] : undefined;
  }
  if (expression.type === "MemberExpression") {
    if (
      expression.computed &&
      (expression.property.type !== "Literal" ||
        typeof expression.property.value !== "string")
    ) {
      return undefined;
    }
    const name = propertyName(expression.property);
    if (name === undefined) {
      return undefined;
    }
    const path = memberPath(expression.object, root);
    path?.push(name);
    return path;
  }
  if (expression.type === "CallExpression") {
    return memberPath(expression.callee, root);
  }
  return undefined;
};

type CollectTimeoutViolationsOptions = {
  relativePath: string;
  source: string;
};

/** Find Bun timeout overrides that bypass the property-run scale factor. */
export const collectPropertyTimeoutViolations = ({
  relativePath,
  source,
}: CollectTimeoutViolationsOptions): string[] => {
  const parsed = parseSource(relativePath, source);
  const bindings = bunTestBindings(parsed.program);
  const violations: string[] = [];
  const report = (node: Node, api: string) => {
    const { line } = parsed.locate(node.start);
    violations.push(
      `${relativePath}:${line}: ${api} timeout is not factor-scaled`,
    );
  };

  const inspectOptions = (options: ObjectExpression, api: string) => {
    for (const member of options.properties) {
      if (
        member.type === "Property" &&
        !member.shorthand &&
        !member.method &&
        !member.computed &&
        member.kind === "init" &&
        propertyName(member.key) === "timeout"
      ) {
        if (!isPropertyTestTimeoutCall(member.value)) {
          report(member.value, api);
        }
        continue;
      }
      if (
        member.type === "Property" &&
        member.shorthand &&
        propertyName(member.key) === "timeout"
      ) {
        report(member, api);
        continue;
      }
      if (member.type !== "SpreadElement") {
        continue;
      }
      if (member.argument.type === "ObjectExpression") {
        inspectOptions(member.argument, api);
        continue;
      }
      report(member.argument, api);
    }
  };

  walk(parsed.program, (node, ancestors) => {
    if (node.type !== "CallExpression") {
      return;
    }

    // In `test.each(cases)(...)`, only the outer call has the test signature.
    const parent = ancestors.at(-1);
    if (parent?.type === "CallExpression" && parent.callee === node) {
      return;
    }

    const identifier = rootIdentifier(node.callee);
    const namedApi =
      identifier === undefined
        ? undefined
        : bindings.named.get(identifier.name);
    const members =
      identifier === undefined
        ? undefined
        : memberPath(node.callee, identifier.name);
    const namespaceMember =
      identifier !== undefined && bindings.namespaces.has(identifier.name)
        ? members?.at(0)
        : undefined;
    const namedJestSetTimeout =
      namedApi === BUN_JEST_BINDING &&
      members?.length === 1 &&
      members.at(0) === "setTimeout";
    const namespaceJestSetTimeout =
      namespaceMember === BUN_JEST_BINDING &&
      members?.length === 2 &&
      members.at(1) === "setTimeout";
    let api: string | undefined;
    if (namedJestSetTimeout || namespaceJestSetTimeout) {
      api = "jest.setTimeout";
    } else if (namedApi !== BUN_JEST_BINDING) {
      api =
        namedApi ??
        (namespaceMember !== undefined && BUN_TIMEOUT_APIS.has(namespaceMember)
          ? namespaceMember
          : undefined);
    }
    if (api === undefined) {
      return;
    }

    if (api === "setDefaultTimeout" || api === "jest.setTimeout") {
      const timeout = node.arguments.at(0);
      if (timeout !== undefined && !isPropertyTestTimeoutCall(timeout)) {
        report(timeout, api);
      }
      return;
    }

    for (const argument of node.arguments) {
      if (argument.type === "ObjectExpression") {
        inspectOptions(argument, api);
      }
    }

    const positionalIndex = api === "test" || api === "it" ? 2 : 1;
    const positionalTimeout = node.arguments.at(positionalIndex);
    if (
      positionalTimeout !== undefined &&
      positionalTimeout.type !== "ObjectExpression" &&
      positionalTimeout.type !== "ArrowFunctionExpression" &&
      positionalTimeout.type !== "FunctionExpression" &&
      !isPropertyTestTimeoutCall(positionalTimeout) &&
      !(
        positionalTimeout.type === "Identifier" &&
        positionalTimeout.name === "undefined"
      )
    ) {
      report(positionalTimeout, api);
    }
  });
  return violations;
};
