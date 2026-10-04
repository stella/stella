import { panic } from "better-result";
import ts from "typescript";

import { parseSource } from "./parse-memo.ts";

export type StatusColumns = Readonly<Record<string, readonly string[]>>;

const unwrap = (expression: ts.Expression): ts.Expression => {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return unwrap(expression.expression);
  }
  return expression;
};

const propertyName = (name: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  if (
    ts.isComputedPropertyName(name) &&
    ts.isStringLiteralLike(name.expression)
  ) {
    return name.expression.text;
  }
  return undefined;
};

const methodName = (expression: ts.Expression): string | undefined => {
  const member = unwrap(expression);
  if (ts.isPropertyAccessExpression(member)) {
    return member.name.text;
  }
  if (
    ts.isElementAccessExpression(member) &&
    ts.isStringLiteralLike(member.argumentExpression)
  ) {
    return member.argumentExpression.text;
  }
  return undefined;
};

const receiver = (expression: ts.Expression): ts.Expression | undefined => {
  const member = unwrap(expression);
  return ts.isPropertyAccessExpression(member) ||
    ts.isElementAccessExpression(member)
    ? member.expression
    : undefined;
};

type Binding =
  | { type: "import"; source: string; name: string }
  | { type: "value"; expression: ts.Expression }
  | { type: "shadow" };

const isScope = (node: ts.Node): boolean =>
  ts.isSourceFile(node) ||
  ts.isBlock(node) ||
  ts.isFunctionLike(node) ||
  ts.isForStatement(node) ||
  ts.isForOfStatement(node) ||
  ts.isForInStatement(node) ||
  ts.isCatchClause(node);

const bindingsFor = (source: ts.SourceFile) => {
  const scopes = new Map<ts.Node, Map<string, Binding>>();
  const scopeOf = (node: ts.Node): ts.Node => {
    let scope = node;
    while (!isScope(scope)) {
      scope = scope.parent;
    }
    return scope;
  };
  const declare = (node: ts.Node, name: ts.BindingName, binding: Binding) => {
    if (!ts.isIdentifier(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) {
          declare(node, element.name, { type: "shadow" });
        }
      }
      return;
    }
    const scope = scopeOf(node);
    const entries = scopes.get(scope) ?? new Map<string, Binding>();
    entries.set(name.text, binding);
    scopes.set(scope, entries);
  };
  const collect = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const importSource = node.moduleSpecifier.text;
      const defaultName = node.importClause?.name;
      if (defaultName !== undefined) {
        declare(node, defaultName, {
          type: "import",
          source: importSource,
          name: "default",
        });
      }
      const named = node.importClause?.namedBindings;
      if (named !== undefined && ts.isNamedImports(named)) {
        for (const item of named.elements) {
          declare(node, item.name, {
            type: "import",
            source: importSource,
            name: (item.propertyName ?? item.name).text,
          });
        }
      } else if (named !== undefined) {
        declare(node, named.name, {
          type: "import",
          source: importSource,
          name: "*",
        });
      }
    }
    if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      declare(
        node,
        node.name,
        ts.isExternalModuleReference(reference) &&
          ts.isStringLiteralLike(reference.expression)
          ? { type: "import", source: reference.expression.text, name: "*" }
          : { type: "shadow" },
      );
    }
    if (ts.isVariableDeclaration(node)) {
      declare(
        node.parent,
        node.name,
        node.initializer === undefined
          ? { type: "shadow" }
          : { type: "value", expression: node.initializer },
      );
    }
    if (ts.isParameter(node)) {
      declare(node.parent, node.name, { type: "shadow" });
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  return (name: string, node: ts.Node): Binding | undefined => {
    let current = node;
    while (true) {
      const binding = scopes.get(current)?.get(name);
      if (binding !== undefined) {
        return binding;
      }
      if (ts.isSourceFile(current)) {
        return undefined;
      }
      current = current.parent;
    }
  };
};

const isSchema = (source: string): boolean =>
  /(?:^|\/)(?:db\/)?(?:[a-z0-9]+-)*schema(?:\/|$)/u.test(
    source.replace(/\.[cm]?[jt]s$/u, ""),
  );

type StatusWriteOptions = {
  content: string;
  file: string;
  columns: StatusColumns;
};

type Mutation =
  | { type: "value"; expression: ts.Expression }
  | { type: "property"; name: string | undefined };

const mutationsFor = (source: ts.SourceFile) => {
  const bindingFor = bindingsFor(source);
  const literalKey = (
    expression: ts.Expression,
    seen = new Set<ts.Node>(),
  ): string | undefined => {
    const value = unwrap(expression);
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    if (ts.isStringLiteralLike(value)) {
      return value.text;
    }
    if (!ts.isIdentifier(value)) {
      return undefined;
    }
    const binding = bindingFor(value.text, value);
    if (binding !== undefined && mutations.has(origin(value) ?? binding)) {
      return undefined;
    }
    return binding?.type === "value"
      ? literalKey(binding.expression, seen)
      : undefined;
  };
  const payloadKey = (name: ts.PropertyName): string | undefined =>
    ts.isComputedPropertyName(name)
      ? literalKey(name.expression)
      : propertyName(name);
  const mutations = new Map<Binding, Mutation[]>();
  const origin = (
    expression: ts.Expression,
    seen = new Set<Binding>(),
  ): Binding | undefined => {
    const value = unwrap(expression);
    if (!ts.isIdentifier(value)) {
      return undefined;
    }
    const binding = bindingFor(value.text, value);
    if (binding === undefined || seen.has(binding)) {
      return undefined;
    }
    seen.add(binding);
    return binding.type === "value" &&
      ts.isIdentifier(unwrap(binding.expression))
      ? (origin(binding.expression, seen) ?? binding)
      : binding;
  };
  const recordMutation = (expression: ts.Expression, mutation: Mutation) => {
    const binding = origin(expression);
    if (binding === undefined) {
      return;
    }
    const previous = mutations.get(binding) ?? [];
    previous.push(mutation);
    mutations.set(binding, previous);
  };
  const collectMutations = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const left = unwrap(node.left);
      if (ts.isIdentifier(left)) {
        recordMutation(left, { type: "value", expression: node.right });
      } else {
        const object = receiver(left);
        if (object !== undefined) {
          recordMutation(object, {
            type: "property",
            name:
              methodName(left) ??
              (ts.isElementAccessExpression(left)
                ? literalKey(left.argumentExpression)
                : undefined),
          });
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const first = node.arguments.at(0);
      const calledObject = receiver(node.expression);
      if (
        first !== undefined &&
        calledObject !== undefined &&
        ts.isIdentifier(calledObject)
      ) {
        const object = calledObject.text;
        const method = methodName(node.expression);
        if (
          object === "Object" &&
          (method === "assign" || method === "defineProperties")
        ) {
          for (const argument of node.arguments.slice(1)) {
            recordMutation(first, { type: "value", expression: argument });
          }
        }
        if (
          (object === "Object" && method === "defineProperty") ||
          (object === "Reflect" && method === "set")
        ) {
          const key = node.arguments.at(1);
          recordMutation(first, {
            type: "property",
            name: key === undefined ? undefined : literalKey(key),
          });
        }
      }
    }
    ts.forEachChild(node, collectMutations);
  };
  collectMutations(source);
  return { bindingFor, literalKey, payloadKey, mutations, origin };
};

const tablesFor = (
  columns: StatusColumns,
  inspector: ReturnType<typeof mutationsFor>,
) => {
  const { bindingFor, mutations, origin } = inspector;
  const tableOf = (
    expression: ts.Expression,
    seen = new Set<ts.Node>(),
  ): string | undefined => {
    const value = unwrap(expression);
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    if (ts.isIdentifier(value)) {
      const binding = bindingFor(value.text, value);
      if (binding === undefined) {
        return Object.hasOwn(columns, value.text) ? value.text : undefined;
      }
      if (binding.type === "value") {
        if (mutations.has(origin(value) ?? binding)) {
          return undefined;
        }
        return tableOf(binding.expression, seen);
      }
      return binding.type === "import" && Object.hasOwn(columns, binding.name)
        ? binding.name
        : undefined;
    }
    if (
      (ts.isPropertyAccessExpression(value) ||
        ts.isElementAccessExpression(value)) &&
      ts.isIdentifier(value.expression)
    ) {
      const binding = bindingFor(value.expression.text, value.expression);
      const name = methodName(value);
      return binding?.type === "import" &&
        binding.name === "*" &&
        name !== undefined &&
        Object.hasOwn(columns, name)
        ? name
        : undefined;
    }
    return undefined;
  };
  const knownOtherTable = (
    expression: ts.Expression,
    seen = new Set<ts.Node>(),
  ): boolean => {
    const value = unwrap(expression);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (ts.isIdentifier(value)) {
      const binding = bindingFor(value.text, value);
      if (binding === undefined) {
        return !Object.hasOwn(columns, value.text);
      }
      if (binding.type === "value") {
        return (
          !mutations.has(origin(value) ?? binding) &&
          knownOtherTable(binding.expression, seen)
        );
      }
      return (
        binding.type === "import" &&
        isSchema(binding.source) &&
        !Object.hasOwn(columns, binding.name)
      );
    }
    const object = receiver(value);
    if (object !== undefined && ts.isIdentifier(object)) {
      const binding = bindingFor(object.text, object);
      const name = methodName(value);
      return (
        binding?.type === "import" &&
        binding.name === "*" &&
        isSchema(binding.source) &&
        name !== undefined &&
        !Object.hasOwn(columns, name)
      );
    }
    return false;
  };
  const lifecycleKeys = [...new Set(Object.values(columns).flat())];
  const mutationKeys = (
    expression: ts.Expression,
  ): readonly string[] | undefined => {
    const value = unwrap(expression);
    if (!ts.isCallExpression(value)) {
      return undefined;
    }
    const argument = value.arguments.at(0);
    if (
      (methodName(value.expression) === "update" ||
        methodName(value.expression) === "insert") &&
      argument !== undefined
    ) {
      const table = tableOf(argument);
      if (table !== undefined) {
        return columns[table];
      }
      return knownOtherTable(argument) ? undefined : lifecycleKeys;
    }
    const target = receiver(value.expression);
    return target === undefined ? undefined : mutationKeys(target);
  };
  return { lifecycleKeys, mutationKeys };
};

const payloadsFor = (inspector: ReturnType<typeof mutationsFor>) => {
  const { bindingFor, mutations, origin, payloadKey } = inspector;
  const containsStatus = (
    expression: ts.Expression,
    keys: readonly string[],
    seen = new Set<ts.Node>(),
  ): boolean => {
    const value = unwrap(expression);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (ts.isConditionalExpression(value)) {
      return (
        containsStatus(value.whenTrue, keys, seen) ||
        containsStatus(value.whenFalse, keys, seen)
      );
    }
    if (
      ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      if (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        return containsStatus(value.right, keys, seen);
      }
      return (
        containsStatus(value.left, keys, seen) ||
        containsStatus(value.right, keys, seen)
      );
    }
    if (ts.isIdentifier(value)) {
      const binding = bindingFor(value.text, value);
      if (binding?.type !== "value") {
        return true;
      }
      const changed = mutations.get(origin(value) ?? binding) ?? [];
      return (
        changed.some((mutation) => {
          switch (mutation.type) {
            case "value":
              return containsStatus(mutation.expression, keys, seen);
            case "property":
              return (
                mutation.name === undefined || keys.includes(mutation.name)
              );
            default:
              mutation satisfies never;
              return panic("Unknown payload mutation");
          }
        }) || containsStatus(binding.expression, keys, seen)
      );
    }
    if (
      ts.isCallExpression(value) &&
      ts.isPropertyAccessExpression(value.expression) &&
      ts.isIdentifier(value.expression.expression)
    ) {
      const argument = value.arguments.at(0);
      if (
        value.expression.expression.text === "Object" &&
        value.expression.name.text === "freeze" &&
        argument !== undefined
      ) {
        return containsStatus(argument, keys, seen);
      }
    }
    if (!ts.isObjectLiteralExpression(value)) {
      return !ts.isLiteralExpression(value);
    }
    return value.properties.some((property) =>
      ts.isSpreadAssignment(property)
        ? containsStatus(property.expression, keys, seen)
        : payloadKey(property.name) === undefined ||
          keys.includes(payloadKey(property.name) ?? ""),
    );
  };
  const conflictSetWrites = (
    expression: ts.Expression,
    keys: readonly string[],
    seen = new Set<ts.Node>(),
  ): boolean => {
    const value = unwrap(expression);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (ts.isIdentifier(value)) {
      const binding = bindingFor(value.text, value);
      if (binding?.type !== "value") {
        return true;
      }
      const changes = mutations.get(origin(value) ?? binding) ?? [];
      return (
        changes.some((change) =>
          change.type === "property"
            ? change.name === undefined || change.name === "set"
            : conflictSetWrites(change.expression, keys, seen),
        ) || conflictSetWrites(binding.expression, keys, seen)
      );
    }
    if (ts.isConditionalExpression(value)) {
      return (
        conflictSetWrites(value.whenTrue, keys, seen) ||
        conflictSetWrites(value.whenFalse, keys, seen)
      );
    }
    if (!ts.isObjectLiteralExpression(value)) {
      return true;
    }
    return value.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) {
        return conflictSetWrites(property.expression, keys, seen);
      }
      if (
        ts.isPropertyAssignment(property) &&
        payloadKey(property.name) === "set"
      ) {
        return containsStatus(property.initializer, keys);
      }
      if (
        ts.isShorthandPropertyAssignment(property) &&
        property.name.text === "set"
      ) {
        return containsStatus(property.name, keys);
      }
      return false;
    });
  };
  return { containsStatus, conflictSetWrites };
};

const sqlTextFor = (
  literalKey: ReturnType<typeof mutationsFor>["literalKey"],
) => {
  const sqlText = (template: ts.TemplateLiteral): string => {
    if (ts.isNoSubstitutionTemplateLiteral(template)) {
      return template.text;
    }
    let text = template.head.text;
    for (const span of template.templateSpans) {
      const value = unwrap(span.expression);
      const name = literalKey(value) ?? methodName(value) ?? "__dynamic__";
      text += `${name}${span.literal.text}`;
    }
    return text;
  };
  const concatenatedSql = (expression: ts.Expression): string => {
    const value = unwrap(expression);
    if (ts.isStringLiteral(value)) {
      return value.text;
    }
    if (
      ts.isTemplateExpression(value) ||
      ts.isNoSubstitutionTemplateLiteral(value)
    ) {
      return sqlText(value);
    }
    if (
      ts.isBinaryExpression(value) &&
      value.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      return concatenatedSql(value.left) + concatenatedSql(value.right);
    }
    return "__dynamic__";
  };
  return { sqlText, concatenatedSql };
};

// Unknown parameter/re-export table handles and opaque payloads are measured
// conservatively. Static SQL text is scanned separately; SQL assembled wholly
// inside an external function requires type information or runtime tracing.
export const statusWriteCalls = ({
  content,
  file,
  columns,
}: StatusWriteOptions): ts.Node[] => {
  const source = parseSource({ text: content, fileName: file });
  const inspector = mutationsFor(source);
  const { lifecycleKeys, mutationKeys } = tablesFor(columns, inspector);
  const { containsStatus, conflictSetWrites } = payloadsFor(inspector);
  const { sqlText, concatenatedSql } = sqlTextFor(inspector.literalKey);
  const matches: ts.Node[] = [];
  const recordSql = (node: ts.Node, text: string) => {
    const count = countRawLifecycleSqlWrites(text, lifecycleKeys);
    for (let index = 0; index < count; index += 1) {
      matches.push(node);
    }
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      (methodName(node.expression) === "set" ||
        methodName(node.expression) === "onConflictDoUpdate")
    ) {
      const target = receiver(node.expression);
      const keys = target === undefined ? undefined : mutationKeys(target);
      const payload = node.arguments.at(0);
      if (
        keys !== undefined &&
        payload !== undefined &&
        (methodName(node.expression) === "onConflictDoUpdate"
          ? conflictSetWrites(payload, keys)
          : containsStatus(payload, keys))
      ) {
        matches.push(node);
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      recordSql(node, sqlText(node.template));
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      !ts.isTaggedTemplateExpression(node.parent)
    ) {
      recordSql(node, node.text);
    } else if (
      ts.isTemplateExpression(node) &&
      !ts.isTaggedTemplateExpression(node.parent)
    ) {
      recordSql(node, sqlText(node));
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      !(
        ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
      )
    ) {
      recordSql(node, concatenatedSql(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return matches;
};

const visibleSqlText = (text: string): string => {
  const visible: string[] = [];
  let state:
    | "code"
    | "string"
    | "identifier"
    | "line-comment"
    | "block-comment" = "code";
  let blockDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    switch (state) {
      case "string":
        if (char === "'" && next === "'") {
          index += 1;
        } else if (char === "'") {
          state = "code";
        }
        visible.push(" ");
        break;
      case "identifier":
        visible.push(char ?? "");
        if (char === '"' && next === '"') {
          visible.push(next);
          index += 1;
        } else if (char === '"') {
          state = "code";
        }
        break;
      case "line-comment":
        if (char === "\n") {
          state = "code";
        }
        visible.push(" ");
        break;
      case "block-comment":
        if (char === "/" && next === "*") {
          blockDepth += 1;
          index += 1;
        } else if (char === "*" && next === "/") {
          blockDepth -= 1;
          index += 1;
          if (blockDepth === 0) {
            state = "code";
          }
        }
        visible.push(" ");
        break;
      case "code":
        if (char === "'") {
          state = "string";
          visible.push(" ");
        } else if (char === '"') {
          state = "identifier";
          visible.push(char);
        } else if (char === "-" && next === "-") {
          state = "line-comment";
          visible.push(" ");
          index += 1;
        } else if (char === "/" && next === "*") {
          state = "block-comment";
          blockDepth = 1;
          visible.push(" ");
          index += 1;
        } else {
          visible.push(char ?? "");
        }
        break;
      default:
        state satisfies never;
        panic("Unknown SQL scanner state");
    }
  }
  return visible.join("");
};

const hasLifecycleAssignments = (
  assignments: string,
  lifecycleKeys: readonly string[],
): boolean => {
  const keys = [
    ...assignments.matchAll(
      /(?:^|,)\s*(?:"(?<quoted>[^"]+)"|(?<bare>[\w$]+))\s*=/gu,
    ),
  ];
  const lifecycle = keys.some((key) => {
    const name = key.groups?.["quoted"] ?? key.groups?.["bare"] ?? "";
    return (
      name === "__dynamic__" ||
      /(?:status|state|phase)$/iu.test(name) ||
      lifecycleKeys.includes(name)
    );
  });
  const tuple = assignments.trimStart();
  const closing = tuple.indexOf(")");
  const tupleLifecycle =
    tuple.startsWith("(") &&
    closing !== -1 &&
    tuple
      .slice(closing + 1)
      .trimStart()
      .startsWith("=") &&
    tuple
      .slice(1, closing)
      .split(",")
      .some((key) => {
        const name = key.trim().replaceAll('"', "");
        return (
          /(?:status|state|phase)$/iu.test(name) || lifecycleKeys.includes(name)
        );
      });
  return lifecycle || tupleLifecycle;
};

/** Conservative text backstop, shared by lint diagnostics and the debt metric. */
export const countRawLifecycleSqlWrites = (
  text: string,
  lifecycleKeys: readonly string[],
): number => {
  let count = 0;
  for (const statement of visibleSqlText(text).split(";")) {
    const markers = [
      ...statement.matchAll(/\b(?:UPDATE|SET|WHERE|RETURNING)\b/giu),
    ];
    for (const [index, marker] of markers.entries()) {
      const set = markers.at(index + 1);
      if (
        marker[0].toUpperCase() !== "UPDATE" ||
        set?.[0].toUpperCase() !== "SET"
      ) {
        continue;
      }
      const end = markers.at(index + 2)?.index ?? statement.length;
      const assignments = statement.slice(set.index + set[0].length, end);
      if (hasLifecycleAssignments(assignments, lifecycleKeys)) {
        count += 1;
      }
    }
  }
  return count;
};

export const unmanagedTransitionTables = (
  content: string,
): readonly string[] => {
  const source = parseSource({
    text: content,
    fileName: "transition-specs.ts",
  });
  const bindingFor = bindingsFor(source);
  const objectOf = (
    expression: ts.Expression,
    seen = new Set<ts.Node>(),
  ): ts.ObjectLiteralExpression | undefined => {
    const value = unwrap(expression);
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    if (ts.isObjectLiteralExpression(value)) {
      return value;
    }
    if (!ts.isIdentifier(value)) {
      return undefined;
    }
    const binding = bindingFor(value.text, value);
    return binding?.type === "value"
      ? objectOf(binding.expression, seen)
      : undefined;
  };
  const hasUnmanaged = (
    object: ts.ObjectLiteralExpression,
    seen = new Set<ts.Node>(),
  ): boolean => {
    if (seen.has(object)) {
      return false;
    }
    seen.add(object);
    return object.properties.some((property) => {
      if (!ts.isSpreadAssignment(property)) {
        return propertyName(property.name) === "unmanaged";
      }
      const spread = objectOf(property.expression);
      return spread !== undefined && hasUnmanaged(spread, seen);
    });
  };
  let declarations: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "TRANSITIONS" &&
      node.initializer !== undefined
    ) {
      declarations = objectOf(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (declarations === undefined) {
    return panic(
      "Transition specs require a statically readable TRANSITIONS object",
    );
  }
  const unmanaged = new Set<string>();
  const collect = (
    object: ts.ObjectLiteralExpression,
    seen = new Set<ts.Node>(),
  ) => {
    if (seen.has(object)) {
      return;
    }
    seen.add(object);
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = objectOf(property.expression);
        if (spread === undefined) {
          panic("Transition spec spreads must be statically readable");
        }
        collect(spread, seen);
        continue;
      }
      if (
        !ts.isPropertyAssignment(property) &&
        !ts.isShorthandPropertyAssignment(property)
      ) {
        panic("Transition spec entries must be properties");
      }
      const name = propertyName(property.name);
      if (name === undefined) {
        panic("Transition spec table keys must be static");
      }
      const value = objectOf(
        ts.isPropertyAssignment(property)
          ? property.initializer
          : property.name,
      );
      if (value !== undefined && hasUnmanaged(value)) {
        unmanaged.add(name);
      }
    }
  };
  collect(declarations);
  return [...unmanaged].toSorted();
};

export const countUnmanagedTransitionSpecs = (content: string): number =>
  unmanagedTransitionTables(content).length;
