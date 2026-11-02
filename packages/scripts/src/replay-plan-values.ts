/**
 * Static inventories that judge an ORM write by its payload read through a
 * case-law replay plan: `.set(write.set)` writes exactly the values that
 * `const write = replayWrite(table, values)` was given.
 */
import type { Node, Program } from "./syntax-tree";

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

/**
 * The values object behind a `plan.set` payload, from the nearest enclosing
 * declaration of `plan`; null when the payload is not a replay plan's SET, so
 * callers keep treating it as opaque.
 */
export const replayPlanValues = (
  payload: Node,
  ancestors: readonly Node[],
  planners: ReadonlySet<string>,
): Node | null => {
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
          ? (init.arguments.at(1) ?? null)
          : null;
      }
    }
  }
  return null;
};
