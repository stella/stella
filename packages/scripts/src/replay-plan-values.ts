/**
 * Static inventories that judge an ORM write by its payload read through a
 * case-law replay plan: `.set(write.set)` writes exactly the values that
 * `const write = replayWrite(table, values)` was given.
 */
import type { CallExpression, Node, Program } from "./syntax-tree";

export const REPLAY_WRITE_MODULE = "@/api/lib/case-law/replay-write";

/** Local names bound to `replayWrite` from the replay-write owner. */
export const replayPlanners = (program: Program): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const statement of program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.source.value !== REPLAY_WRITE_MODULE
    ) {
      continue;
    }
    for (const binding of statement.specifiers) {
      if (
        binding.type === "ImportSpecifier" &&
        (binding.imported.type === "Identifier"
          ? binding.imported.name
          : binding.imported.value) === "replayWrite"
      ) {
        names.add(binding.local.name);
      }
    }
  }
  return names;
};

const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

/** Whether a parameter pattern binds `name` anywhere inside it. */
const patternBinds = (node: Node | null, name: string): boolean => {
  if (node === null) {
    return false;
  }
  if (node.type === "Identifier") {
    return node.name === name;
  }
  if (node.type === "AssignmentPattern") {
    return patternBinds(node.left, name);
  }
  if (node.type === "RestElement") {
    return patternBinds(node.argument, name);
  }
  if (node.type === "ArrayPattern") {
    return node.elements.some((element) => patternBinds(element, name));
  }
  if (node.type === "ObjectPattern") {
    return node.properties.some((property) =>
      property.type === "RestElement"
        ? patternBinds(property.argument, name)
        : patternBinds(property.value, name),
    );
  }
  return false;
};

/**
 * The `replayWrite(...)` call behind a `plan.set` payload, from the nearest
 * enclosing declaration of `plan`; null when the payload is not a replay
 * plan's SET.
 */
const replayPlanCall = (
  payload: Node,
  ancestors: readonly Node[],
  planners: ReadonlySet<string>,
): CallExpression | null => {
  if (
    payload.type !== "MemberExpression" ||
    payload.computed ||
    payload.object.type !== "Identifier" ||
    payload.property.type !== "Identifier" ||
    payload.property.name !== "set"
  ) {
    return null;
  }
  const plan = payload.object.name;
  for (const scope of ancestors.toReversed()) {
    // A nearer parameter shadows any outer plan of the same name: its SET is
    // whatever the caller passed, so the payload stays opaque.
    if (
      FUNCTION_TYPES.has(scope.type) &&
      "params" in scope &&
      scope.params.some((parameter) => patternBinds(parameter, plan))
    ) {
      return null;
    }
    if (scope.type !== "BlockStatement" && scope.type !== "Program") {
      continue;
    }
    for (const statement of scope.body) {
      if (statement.type !== "VariableDeclaration") {
        continue;
      }
      for (const declarator of statement.declarations) {
        if (
          declarator.id.type !== "Identifier" ||
          declarator.id.name !== plan
        ) {
          continue;
        }
        const init = declarator.init;
        return init?.type === "CallExpression" &&
          init.callee.type === "Identifier" &&
          planners.has(init.callee.name)
          ? init
          : null;
      }
    }
  }
  return null;
};

/**
 * The values object behind a `plan.set` payload; null when the payload is not
 * a replay plan's SET, so callers keep treating it as opaque.
 */
export const replayPlanValues = (
  payload: Node,
  ancestors: readonly Node[],
  planners: ReadonlySet<string>,
): Node | null =>
  replayPlanCall(payload, ancestors, planners)?.arguments.at(1) ?? null;

/** Marks a `modifiedAt` column the inventory cannot name statically. */
export const UNKNOWN_MODIFIED_COLUMN = "*";

type StaticProperty =
  { type: "found"; value: Node } | { type: "absent" } | { type: "unknown" };

const staticProperty = (object: Node, name: string): StaticProperty => {
  if (object.type !== "ObjectExpression") {
    return { type: "unknown" };
  }
  for (const property of object.properties) {
    if (property.type === "SpreadElement" || property.computed) {
      return { type: "unknown" };
    }
    if (property.key.type === "Identifier" && property.key.name === name) {
      return { type: "found", value: property.value };
    }
  }
  return { type: "absent" };
};

/**
 * The column a plan's `modifiedAt` option adds to its SET, by property name:
 * `UNKNOWN_MODIFIED_COLUMN` when the options are not static, null when the
 * payload is not a plan's SET or the plan sets no modification column.
 */
export const replayPlanModifiedColumn = (
  payload: Node,
  ancestors: readonly Node[],
  planners: ReadonlySet<string>,
): string | null => {
  const options = replayPlanCall(payload, ancestors, planners)?.arguments.at(2);
  if (options === undefined) {
    return null;
  }
  const modifiedAt = staticProperty(options, "modifiedAt");
  if (modifiedAt.type === "absent") {
    return null;
  }
  if (modifiedAt.type === "unknown") {
    return UNKNOWN_MODIFIED_COLUMN;
  }
  const column = staticProperty(modifiedAt.value, "column");
  return column.type === "found" &&
    column.value.type === "MemberExpression" &&
    !column.value.computed &&
    column.value.property.type === "Identifier"
    ? column.value.property.name
    : UNKNOWN_MODIFIED_COLUMN;
};
