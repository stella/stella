import { panic } from "better-result";

import {
  type BindingPattern,
  type BindingRestElement,
  type Expression as OxcExpression,
  type FormalParameterRest,
  type Node,
  type ObjectExpression,
  type ObjectProperty as Property,
  parseSource,
  type Program,
  type SpreadElement,
  staticPropertyName,
  type TemplateLiteral,
  walk,
} from "../packages/scripts/src/syntax-tree.ts";

type Expression = OxcExpression | SpreadElement;

export type StatusColumns = Readonly<Record<string, readonly string[]>>;

const unwrap = (expression: Expression): Expression => {
  if (
    expression.type === "ParenthesizedExpression" ||
    expression.type === "TSAsExpression" ||
    expression.type === "TSSatisfiesExpression" ||
    expression.type === "TSNonNullExpression" ||
    expression.type === "ChainExpression"
  ) {
    return unwrap(expression.expression);
  }
  return expression;
};
const stringValue = (node: Node): string | undefined => {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.at(0)?.value.cooked ?? undefined;
  }
  return undefined;
};
const propertyName = (name: Node): string | undefined =>
  name.type === "Identifier" ? name.name : stringValue(name);
const methodName = (expression: Expression): string | undefined => {
  const member = unwrap(expression);
  if (member.type !== "MemberExpression") {
    return undefined;
  }
  return member.computed
    ? stringValue(member.property)
    : propertyName(member.property);
};
const receiver = (expression: Expression): Expression | undefined => {
  const member = unwrap(expression);
  return member.type === "MemberExpression" ? member.object : undefined;
};
type Binding =
  | { type: "import"; source: string; name: string }
  | { type: "value"; expression: Expression }
  | { type: "shadow" };
const isScope = (node: Node): boolean =>
  node.type === "Program" ||
  node.type === "BlockStatement" ||
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression" ||
  node.type === "ArrowFunctionExpression" ||
  node.type === "ForStatement" ||
  node.type === "ForOfStatement" ||
  node.type === "ForInStatement" ||
  node.type === "CatchClause";
const bindingsFor = (source: Program) => {
  const parents = new Map<Node, Node>();
  walk(source, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (parent !== undefined) {
      parents.set(node, parent);
    }
  });
  const scopes = new Map<Node, Map<string, Binding>>();
  const declare = (
    node: Node,
    name: BindingPattern | BindingRestElement | FormalParameterRest,
    binding: Binding,
  ): void => {
    if (name.type !== "Identifier") {
      if (name.type === "AssignmentPattern") {
        declare(node, name.left, { type: "shadow" });
      } else if (name.type === "RestElement") {
        declare(node, name.argument, { type: "shadow" });
      } else if (name.type === "ArrayPattern") {
        for (const element of name.elements) {
          if (element !== null) {
            declare(node, element, { type: "shadow" });
          }
        }
      } else {
        for (const element of name.properties) {
          declare(
            node,
            element.type === "RestElement" ? element.argument : element.value,
            { type: "shadow" },
          );
        }
      }
      return;
    }
    let scope = node;
    while (!isScope(scope)) {
      const parent = parents.get(scope);
      if (parent === undefined) {
        panic("Missing binding scope");
      }
      scope = parent;
    }
    const entries = scopes.get(scope) ?? new Map<string, Binding>();
    entries.set(name.name, binding);
    scopes.set(scope, entries);
  };
  walk(source, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (node.type === "ImportDeclaration") {
      for (const item of node.specifiers) {
        let name = "default";
        if (item.type === "ImportNamespaceSpecifier") {
          name = "*";
        } else if (item.type === "ImportSpecifier") {
          name = propertyName(item.imported) ?? "";
        }
        declare(node, item.local, {
          type: "import",
          source: node.source.value,
          name,
        });
      }
    }
    if (node.type === "TSImportEqualsDeclaration") {
      const reference = node.moduleReference;
      declare(
        node,
        node.id,
        reference.type === "TSExternalModuleReference"
          ? { type: "import", source: reference.expression.value, name: "*" }
          : { type: "shadow" },
      );
    }
    if (node.type === "VariableDeclarator") {
      declare(
        parent ?? node,
        node.id,
        node.init === null
          ? { type: "shadow" }
          : { type: "value", expression: node.init },
      );
    }
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      for (const parameter of node.params) {
        declare(
          node,
          parameter.type === "TSParameterProperty"
            ? parameter.parameter
            : parameter,
          { type: "shadow" },
        );
      }
    }
  });
  return (name: string, node: Node): Binding | undefined => {
    for (
      let current: Node | undefined = node;
      current !== undefined;
      current = parents.get(current)
    ) {
      const binding = scopes.get(current)?.get(name);
      if (binding !== undefined) {
        return binding;
      }
    }
    return undefined;
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
  | { type: "value"; expression: Expression }
  | { type: "property"; name: string | undefined };

const mutationsFor = (source: Program) => {
  const bindingFor = bindingsFor(source);
  const literalKey = (
    expression: Expression,
    seen = new Set<Node>(),
  ): string | undefined => {
    const value = unwrap(expression);
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    if (stringValue(value) !== undefined) {
      return stringValue(value);
    }
    if (value.type !== "Identifier") {
      return undefined;
    }
    const binding = bindingFor(value.name, value);
    if (binding !== undefined && mutations.has(origin(value) ?? binding)) {
      return undefined;
    }
    return binding?.type === "value"
      ? literalKey(binding.expression, seen)
      : undefined;
  };
  const payloadKey = (property: Property): string | undefined => {
    if (!property.computed) {
      return propertyName(property.key);
    }
    return property.key.type === "PrivateIdentifier"
      ? undefined
      : literalKey(property.key);
  };
  const mutations = new Map<Binding, Mutation[]>();
  const origin = (
    expression: Expression,
    seen = new Set<Binding>(),
  ): Binding | undefined => {
    const value = unwrap(expression);
    if (value.type !== "Identifier") {
      return undefined;
    }
    const binding = bindingFor(value.name, value);
    if (binding === undefined || seen.has(binding)) {
      return undefined;
    }
    seen.add(binding);
    return binding.type === "value" &&
      unwrap(binding.expression).type === "Identifier"
      ? (origin(binding.expression, seen) ?? binding)
      : binding;
  };
  const recordMutation = (expression: Expression, mutation: Mutation) => {
    const binding = origin(expression);
    if (binding === undefined) {
      return;
    }
    const previous = mutations.get(binding) ?? [];
    previous.push(mutation);
    mutations.set(binding, previous);
  };
  const collectMutations = (node: Node) => {
    if (node.type === "AssignmentExpression") {
      const left = node.left;
      if (left.type === "Identifier") {
        recordMutation(left, { type: "value", expression: node.right });
      } else if (
        left.type !== "ArrayPattern" &&
        left.type !== "ObjectPattern"
      ) {
        // A destructuring target mutates no single receiver.
        const object = receiver(left);
        if (object !== undefined) {
          recordMutation(object, {
            type: "property",
            name:
              methodName(left) ??
              (left.type === "MemberExpression" && left.computed
                ? literalKey(left.property)
                : undefined),
          });
        }
      }
    }
    if (node.type === "CallExpression") {
      const first = node.arguments.at(0);
      const calledObject = receiver(node.callee);
      if (first !== undefined && calledObject?.type === "Identifier") {
        const object = calledObject.name;
        const method = methodName(node.callee);
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
  };
  walk(source, collectMutations);
  return { bindingFor, literalKey, payloadKey, mutations, origin };
};

const tablesFor = (
  columns: StatusColumns,
  inspector: ReturnType<typeof mutationsFor>,
) => {
  const { bindingFor, mutations, origin } = inspector;
  const tableOf = (
    expression: Expression,
    seen = new Set<Node>(),
  ): string | undefined => {
    const value = unwrap(expression);
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    if (value.type === "Identifier") {
      const binding = bindingFor(value.name, value);
      if (binding === undefined) {
        return Object.hasOwn(columns, value.name) ? value.name : undefined;
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
      value.type === "MemberExpression" &&
      value.object.type === "Identifier"
    ) {
      const binding = bindingFor(value.object.name, value.object);
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
    expression: Expression,
    seen = new Set<Node>(),
  ): boolean => {
    const value = unwrap(expression);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (value.type === "Identifier") {
      const binding = bindingFor(value.name, value);
      if (binding === undefined) {
        return !Object.hasOwn(columns, value.name);
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
    if (object?.type === "Identifier") {
      const binding = bindingFor(object.name, object);
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
    expression: Expression,
  ): readonly string[] | undefined => {
    const value = unwrap(expression);
    if (value.type !== "CallExpression") {
      return undefined;
    }
    const argument = value.arguments.at(0);
    if (
      (methodName(value.callee) === "update" ||
        methodName(value.callee) === "insert") &&
      argument !== undefined
    ) {
      const table = tableOf(argument);
      if (table !== undefined) {
        return columns[table];
      }
      return knownOtherTable(argument) ? undefined : lifecycleKeys;
    }
    const target = receiver(value.callee);
    return target === undefined ? undefined : mutationKeys(target);
  };
  return { lifecycleKeys, mutationKeys };
};

const payloadsFor = (inspector: ReturnType<typeof mutationsFor>) => {
  const { bindingFor, mutations, origin, payloadKey } = inspector;
  const containsStatus = (
    expression: Expression,
    keys: readonly string[],
    seen = new Set<Node>(),
  ): boolean => {
    const value = unwrap(expression);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (value.type === "ConditionalExpression") {
      return (
        containsStatus(value.consequent, keys, seen) ||
        containsStatus(value.alternate, keys, seen)
      );
    }
    if (value.type === "LogicalExpression") {
      if (value.operator === "&&") {
        return containsStatus(value.right, keys, seen);
      }
      return (
        containsStatus(value.left, keys, seen) ||
        containsStatus(value.right, keys, seen)
      );
    }
    if (value.type === "Identifier") {
      const binding = bindingFor(value.name, value);
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
      value.type === "CallExpression" &&
      value.callee.type === "MemberExpression" &&
      !value.callee.computed &&
      value.callee.object.type === "Identifier" &&
      value.callee.property.type === "Identifier"
    ) {
      const argument = value.arguments.at(0);
      if (
        value.callee.object.name === "Object" &&
        value.callee.property.name === "freeze" &&
        argument !== undefined
      ) {
        return containsStatus(argument, keys, seen);
      }
    }
    if (value.type !== "ObjectExpression") {
      return !(
        value.type === "TemplateLiteral" ||
        (value.type === "Literal" &&
          (typeof value.value === "string" ||
            typeof value.value === "number" ||
            typeof value.value === "bigint" ||
            "regex" in value))
      );
    }
    return value.properties.some((property) =>
      property.type === "SpreadElement"
        ? containsStatus(property.argument, keys, seen)
        : payloadKey(property) === undefined ||
          keys.includes(payloadKey(property) ?? ""),
    );
  };
  const conflictSetWrites = (
    expression: Expression,
    keys: readonly string[],
    seen = new Set<Node>(),
  ): boolean => {
    const value = unwrap(expression);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (value.type === "Identifier") {
      const binding = bindingFor(value.name, value);
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
    if (value.type === "ConditionalExpression") {
      return (
        conflictSetWrites(value.consequent, keys, seen) ||
        conflictSetWrites(value.alternate, keys, seen)
      );
    }
    if (value.type !== "ObjectExpression") {
      return true;
    }
    return value.properties.some((property) => {
      if (property.type === "SpreadElement") {
        return conflictSetWrites(property.argument, keys, seen);
      }
      if (
        property.kind === "init" &&
        !property.method &&
        payloadKey(property) === "set"
      ) {
        return containsStatus(property.value, keys);
      }
      return false;
    });
  };
  return { containsStatus, conflictSetWrites };
};

const sqlTextFor = (
  literalKey: ReturnType<typeof mutationsFor>["literalKey"],
) => {
  const sqlText = (template: TemplateLiteral): string => {
    let text = template.quasis.at(0)?.value.cooked ?? "";
    for (const [index, expression] of template.expressions.entries()) {
      const value = unwrap(expression);
      const name = literalKey(value) ?? methodName(value) ?? "__dynamic__";
      text += `${name}${template.quasis.at(index + 1)?.value.cooked ?? ""}`;
    }
    return text;
  };
  const concatenatedSql = (expression: Expression): string => {
    const value = unwrap(expression);
    if (value.type === "Literal" && typeof value.value === "string") {
      return value.value;
    }
    if (value.type === "TemplateLiteral") {
      return sqlText(value);
    }
    if (value.type === "BinaryExpression" && value.operator === "+") {
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
}: StatusWriteOptions): Node[] => {
  const source = parseSource(file, content).program;
  const inspector = mutationsFor(source);
  const { lifecycleKeys, mutationKeys } = tablesFor(columns, inspector);
  const { containsStatus, conflictSetWrites } = payloadsFor(inspector);
  const { sqlText, concatenatedSql } = sqlTextFor(inspector.literalKey);
  const matches: Node[] = [];
  const recordSql = (node: Node, text: string) => {
    const count = countRawLifecycleSqlWrites(text, lifecycleKeys);
    for (let index = 0; index < count; index += 1) {
      matches.push(node);
    }
  };
  const visit = (node: Node, ancestors: readonly Node[]) => {
    const parent = ancestors.at(-1);
    if (
      node.type === "CallExpression" &&
      (methodName(node.callee) === "set" ||
        methodName(node.callee) === "onConflictDoUpdate")
    ) {
      const target = receiver(node.callee);
      const keys = target === undefined ? undefined : mutationKeys(target);
      const payload = node.arguments.at(0);
      if (
        keys !== undefined &&
        payload !== undefined &&
        (methodName(node.callee) === "onConflictDoUpdate"
          ? conflictSetWrites(payload, keys)
          : containsStatus(payload, keys))
      ) {
        matches.push(node);
      }
    }
    if (node.type === "TaggedTemplateExpression") {
      recordSql(node, sqlText(node.quasi));
    } else if (
      node.type === "Literal" &&
      typeof node.value === "string" &&
      parent?.type !== "TaggedTemplateExpression"
    ) {
      recordSql(node, node.value);
    } else if (
      node.type === "TemplateLiteral" &&
      parent?.type !== "TaggedTemplateExpression"
    ) {
      recordSql(node, sqlText(node));
    }
    if (
      node.type === "BinaryExpression" &&
      node.operator === "+" &&
      !(parent?.type === "BinaryExpression" && parent.operator === "+")
    ) {
      recordSql(node, concatenatedSql(node));
    }
  };
  walk(source, visit);
  return matches;
};

const visibleSqlText = (text: string): string => {
  const visible: string[] = [];
  let state:
    "code" | "string" | "identifier" | "line-comment" | "block-comment" =
    "code";
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
  const source = parseSource("transition-specs.ts", content).program;
  const bindingFor = bindingsFor(source);
  const objectOf = (
    expression: Expression,
    seen = new Set<Node>(),
  ): ObjectExpression | undefined => {
    const value = unwrap(expression);
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    if (value.type === "ObjectExpression") {
      return value;
    }
    if (value.type !== "Identifier") {
      return undefined;
    }
    const binding = bindingFor(value.name, value);
    return binding?.type === "value"
      ? objectOf(binding.expression, seen)
      : undefined;
  };
  const hasUnmanaged = (
    object: ObjectExpression,
    seen = new Set<Node>(),
  ): boolean => {
    if (seen.has(object)) {
      return false;
    }
    seen.add(object);
    const unmanagedOptions = object.properties.map((property) => {
      if (property.type !== "SpreadElement") {
        const name = staticPropertyName(property);
        if (name === undefined) {
          panic("Transition spec option keys must be static");
        }
        return name === "unmanaged";
      }
      const spread = objectOf(property.argument);
      return spread !== undefined && hasUnmanaged(spread, seen);
    });
    return unmanagedOptions.includes(true);
  };
  let declarations: ObjectExpression | undefined;
  const visit = (node: Node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name === "TRANSITIONS" &&
      node.init !== null
    ) {
      declarations = objectOf(node.init);
    }
  };
  walk(source, visit);
  if (declarations === undefined) {
    return panic(
      "Transition specs require a statically readable TRANSITIONS object",
    );
  }
  const unmanaged = new Set<string>();
  const collect = (object: ObjectExpression, seen = new Set<Node>()) => {
    if (seen.has(object)) {
      return;
    }
    seen.add(object);
    for (const property of object.properties) {
      if (property.type === "SpreadElement") {
        const spread = objectOf(property.argument);
        if (spread === undefined) {
          panic("Transition spec spreads must be statically readable");
        }
        collect(spread, seen);
        continue;
      }
      if (property.method || property.kind !== "init") {
        panic("Transition spec entries must be properties");
      }
      const name = staticPropertyName(property);
      if (name === undefined) {
        panic("Transition spec table keys must be static");
      }
      const value = objectOf(property.value);
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
