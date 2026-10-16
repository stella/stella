import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  isStringLiteral,
  resolveImport,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode, FilenameContext, ScopeContext } from "./utils.ts";
import {
  hasUnownedWorkspaceInsert,
  isPreVisibilityWorkspaceInsert,
} from "./workspace-insert-sql.ts";

const OWNER = "apps/api/src/lib/workspaces/create-workspace-row";
const FIXTURE_OWNER = "apps/api/src/tests/gated-test-database";
const FIXTURE_HELPERS = "apps/api/src/tests/helpers/workspace-creation";
const SCHEMA = new Set([
  "apps/api/src/db/schema",
  "apps/api/src/db/schema/contacts",
]);
const NONPRIVATE = new Set(["admins_and_assigned", "all_members"]);
const REFUSAL_SQL =
  "INSERT INTO workspaces (id,organization_id,lead_user_id,visibility) VALUES ('00000000-0000-4000-8000-0000000000a9',$1,$2,'assigned_only')";
type Context = ScopeContext & FilenameContext;

const initializerOf = (
  context: Context,
  node: unknown,
  seen = new Set<unknown>(),
): AstNode | null => {
  const expression = unwrapExpression(node);
  if (!isIdentifierReference(expression) || seen.has(expression)) {
    return expression;
  }
  const variable = resolveVariable(context, expression);
  const initializer = variable === null ? null : stableInitializer(variable);
  if (initializer === null) {
    return expression;
  }
  seen.add(expression);
  return initializerOf(context, initializer, seen);
};

const nonprivateValue = (context: Context, node: unknown): string | null => {
  const expression = initializerOf(context, node);
  if (isStringLiteral(expression) && NONPRIVATE.has(expression.value)) {
    return expression.value;
  }
  if (expression?.type !== "MemberExpression") {
    return null;
  }
  const binding = resolveImport(context, expression.object);
  if (
    binding?.moduleId !== "@stll/api-contract" ||
    binding.imported !== "MATTER_VISIBILITY"
  ) {
    return null;
  }
  const key = getPropertyName(expression.property);
  return key === "adminsAndAssigned"
    ? "admins_and_assigned"
    : key === "allMembers"
      ? "all_members"
      : null;
};

const nonprivateRows = (context: Context, node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (
    expression?.type === "ArrayExpression" &&
    Array.isArray(expression.elements)
  ) {
    return expression.elements.every((element) =>
      nonprivateRows(context, element),
    );
  }
  if (
    expression?.type === "CallExpression" &&
    isAstNode(expression.callee) &&
    expression.callee.type === "MemberExpression" &&
    Array.isArray(expression.arguments)
  ) {
    const method = getPropertyName(expression.callee.property);
    const globalArray =
      isIdentifierReference(expression.callee.object) &&
      expression.callee.object.name === "Array" &&
      (resolveVariable(context, expression.callee.object)?.defs.length ?? 0) ===
        0;
    const mapperIndex =
      method === "map" ? 0 : method === "from" && globalArray ? 1 : null;
    const mapper =
      mapperIndex === null
        ? null
        : unwrapExpression(expression.arguments.at(mapperIndex));
    return (
      mapper?.type === "ArrowFunctionExpression" &&
      nonprivateRows(context, mapper.body)
    );
  }
  if (
    expression?.type !== "ObjectExpression" ||
    !Array.isArray(expression.properties)
  ) {
    return false;
  }
  let visibility: string | null = null;
  for (const property of expression.properties) {
    if (!isAstNode(property) || property.type === "SpreadElement") {
      visibility = null;
    } else if (property.computed === true && !isStringLiteral(property.key)) {
      visibility = null;
    } else if (getPropertyName(property.key) === "visibility") {
      visibility = nonprivateValue(context, property.value);
    }
  }
  return visibility !== null;
};

const trustedCallback = (context: Context, node: AstNode): AstNode | null => {
  let ancestor: unknown = node.parent;
  while (isAstNode(ancestor)) {
    if (
      ancestor.type === "ArrowFunctionExpression" ||
      ancestor.type === "FunctionExpression"
    ) {
      const property = ancestor.parent;
      const object = isAstNode(property) ? property.parent : null;
      const call = isAstNode(object) ? object.parent : null;
      if (
        !isAstNode(property) ||
        getPropertyName(property.key) !== "insert" ||
        !isAstNode(object) ||
        object.type !== "ObjectExpression" ||
        !isAstNode(call) ||
        call.type !== "CallExpression"
      ) {
        return null;
      }
      const binding = resolveImport(context, call.callee);
      const trusted =
        (binding?.moduleId === OWNER &&
          binding.imported === "withWorkspaceCreation") ||
        (binding?.moduleId === FIXTURE_OWNER &&
          binding.imported === "withGatedWorkspaceCreation") ||
        (binding?.moduleId === FIXTURE_HELPERS &&
          binding.imported === "withPgliteWorkspaceCreation");
      return trusted ? ancestor : null;
    }
    ancestor = ancestor.parent;
  }
  return null;
};

const fromNormalizedRows = (
  context: Context,
  node: unknown,
  callback: AstNode,
  allowElement: boolean,
): boolean => {
  const expression = initializerOf(context, node);
  const parameter = Array.isArray(callback.params)
    ? callback.params.at(0)
    : null;
  if (!isIdentifierReference(parameter)) {
    return false;
  }
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(context, expression);
    if (variable !== null && variable === resolveVariable(context, parameter)) {
      return true;
    }
    const definition = variable?.defs.at(0)?.node;
    const declaration = isAstNode(definition) ? definition.parent : null;
    const loop = isAstNode(declaration) ? declaration.parent : null;
    return (
      allowElement &&
      isAstNode(loop) &&
      loop.type === "ForOfStatement" &&
      fromNormalizedRows(context, loop.right, callback, false)
    );
  }
  if (!allowElement) {
    return false;
  }
  if (
    expression?.type === "LogicalExpression" &&
    expression.operator === "??"
  ) {
    const refusal = unwrapExpression(expression.right);
    const binding =
      refusal?.type === "CallExpression"
        ? resolveImport(context, refusal.callee)
        : null;
    return (
      binding?.moduleId === "better-result" &&
      binding.imported === "panic" &&
      fromNormalizedRows(context, expression.left, callback, true)
    );
  }
  if (expression?.type === "MemberExpression") {
    return fromNormalizedRows(context, expression.object, callback, true);
  }
  const callee =
    expression?.type === "CallExpression"
      ? unwrapExpression(expression.callee)
      : null;
  return (
    callee?.type === "MemberExpression" &&
    getPropertyName(callee.property) === "at" &&
    fromNormalizedRows(context, callee.object, callback, false)
  );
};

type SqlSource = { text: string; ownedIds: Set<number> };
const plainSql = (text: string): SqlSource => ({ text, ownedIds: new Set() });
const joinSql = (left: SqlSource, right: SqlSource): SqlSource => ({
  text: left.text + right.text,
  ownedIds: new Set([
    ...left.ownedIds,
    ...[...right.ownedIds].map((offset) => left.text.length + offset),
  ]),
});

type TemplateSqlOptions = {
  context: Context;
  expression: AstNode;
  seen: ReadonlySet<unknown>;
};
const templateSql = ({
  context,
  expression,
  seen,
}: TemplateSqlOptions): SqlSource | null => {
  if (
    !Array.isArray(expression.quasis) ||
    !Array.isArray(expression.expressions)
  ) {
    return null;
  }
  {
    let result = plainSql("");
    for (const [index, quasi] of expression.quasis.entries()) {
      const value = isAstNode(quasi) ? quasi.value : null;
      if (
        typeof value !== "object" ||
        value === null ||
        !("cooked" in value) ||
        typeof value.cooked !== "string"
      ) {
        return null;
      }
      result = joinSql(result, plainSql(value.cooked));
      if (index < expression.expressions.length) {
        const argument = expression.expressions.at(index);
        const table = resolveImport(context, argument);
        const hole =
          table?.imported === "workspaces" && SCHEMA.has(table.moduleId)
            ? plainSql("workspaces")
            : (sqlText(context, argument, seen) ?? plainSql("__unknown__"));
        result = joinSql(result, hole);
      }
    }
    return result;
  }
};

const sqlText = (
  context: Context,
  node: unknown,
  seen: ReadonlySet<unknown> = new Set(),
): SqlSource | null => {
  const expression = initializerOf(context, node);
  if (expression !== null && seen.has(expression)) {
    return null;
  }
  const nextSeen = new Set(seen);
  if (expression !== null) {
    nextSeen.add(expression);
  }
  const visibility = nonprivateValue(context, expression);
  if (visibility !== null) {
    return plainSql(`'${visibility}'`);
  }
  if (isStringLiteral(expression)) {
    return plainSql(expression.value);
  }
  if (
    expression?.type === "MemberExpression" &&
    getPropertyName(expression.property) === "id"
  ) {
    const callback = trustedCallback(context, expression);
    if (
      callback !== null &&
      fromNormalizedRows(context, expression.object, callback, true)
    ) {
      return { text: "__normalized_id__", ownedIds: new Set([0]) };
    }
  }
  if (expression?.type === "TaggedTemplateExpression") {
    return sqlText(context, expression.quasi, nextSeen);
  }
  if (
    expression?.type === "CallExpression" &&
    Array.isArray(expression.arguments)
  ) {
    const callee = unwrapExpression(expression.callee);
    const argument = initializerOf(context, expression.arguments.at(0));
    if (
      callee?.type === "MemberExpression" &&
      getPropertyName(callee.property) === "identifier" &&
      isStringLiteral(argument)
    ) {
      return plainSql(`"${argument.value.replaceAll('"', '""')}"`);
    }
  }
  if (expression?.type === "TemplateLiteral") {
    return templateSql({ context, expression, seen: nextSeen });
  }
  if (expression?.type === "BinaryExpression" && expression.operator === "+") {
    const left = sqlText(context, expression.left, nextSeen);
    const right = sqlText(context, expression.right, nextSeen);
    return left === null || right === null ? null : joinSql(left, right);
  }
  return null;
};

const refusalTest = (
  context: Context,
  node: AstNode,
  text: string,
): boolean => {
  if (
    !filenameForContext(context).endsWith(
      "apps/api/src/db/matter-steward-rollout.db.test.ts",
    ) ||
    text !== REFUSAL_SQL
  ) {
    return false;
  }
  let ancestor: unknown = node.parent;
  while (isAstNode(ancestor)) {
    if (
      ancestor.type === "CallExpression" &&
      Array.isArray(ancestor.arguments)
    ) {
      const name = ancestor.arguments.at(0);
      if (
        isStringLiteral(name) &&
        name.value ===
          "an unsupported private INSERT is refused before deferred validation"
      ) {
        return true;
      }
    }
    ancestor = ancestor.parent;
  }
  return false;
};

const historicalInsert = (
  context: Context,
  node: AstNode,
  source: string,
): boolean => {
  if (
    !filenameForContext(context).includes(".test.") ||
    !isPreVisibilityWorkspaceInsert(source)
  ) {
    return false;
  }
  let ancestor: unknown = node.parent;
  while (isAstNode(ancestor)) {
    if (
      ancestor.type === "ArrowFunctionExpression" ||
      ancestor.type === "FunctionExpression"
    ) {
      const property = ancestor.parent;
      const object = isAstNode(property) ? property.parent : null;
      const call = isAstNode(object) ? object.parent : null;
      if (
        !isAstNode(property) ||
        getPropertyName(property.key) !== "insert" ||
        !isAstNode(object) ||
        object.type !== "ObjectExpression" ||
        !isAstNode(call) ||
        call.type !== "CallExpression"
      ) {
        return false;
      }
      const binding = resolveImport(context, call.callee);
      return (
        binding?.moduleId === FIXTURE_HELPERS &&
        binding.imported === "withLegacyWorkspaceFixture"
      );
    }
    ancestor = ancestor.parent;
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "no-unowned-workspace-insert" },
  rules: {
    "no-unowned-workspace-insert": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          unowned:
            "Create private matters, or rows with unproven visibility, through create-workspace-row.ts. Its creation owner acquires the complete stewardship prefix before INSERT; a bare lock call is insufficient.",
        },
      },
      createOnce(context) {
        const reported = new Set<number>();
        const reportSql = (node: AstNode, source: SqlSource | null) => {
          if (
            source === null ||
            reported.has(node.range[0]) ||
            !hasUnownedWorkspaceInsert(
              source.text,
              trustedCallback(context, node) === null
                ? new Set()
                : source.ownedIds,
            ) ||
            historicalInsert(context, node, source.text) ||
            refusalTest(context, node, source.text)
          ) {
            return;
          }
          reported.add(node.range[0]);
          context.report({ node, messageId: "unowned" });
        };
        return {
          before() {
            reported.clear();
            const filename = filenameForContext(context);
            return (
              filename.includes("apps/api/") &&
              !filename.endsWith(`${OWNER}.ts`)
            );
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              callee?.type !== "MemberExpression" ||
              !Array.isArray(node.arguments)
            ) {
              return;
            }
            const method = getPropertyName(callee.property);
            if (method === "insert") {
              const table = resolveImport(context, node.arguments.at(0));
              if (
                table?.imported !== "workspaces" ||
                !SCHEMA.has(table.moduleId)
              ) {
                return;
              }
              const valuesMember = node.parent;
              const values = isAstNode(valuesMember)
                ? valuesMember.parent
                : null;
              if (
                isAstNode(valuesMember) &&
                valuesMember.type === "MemberExpression" &&
                getPropertyName(valuesMember.property) === "values" &&
                isAstNode(values) &&
                values.type === "CallExpression" &&
                Array.isArray(values.arguments) &&
                (nonprivateRows(context, values.arguments.at(0)) ||
                  (() => {
                    const callback = trustedCallback(context, node);
                    return (
                      callback !== null &&
                      fromNormalizedRows(
                        context,
                        values.arguments.at(0),
                        callback,
                        false,
                      )
                    );
                  })())
              ) {
                return;
              }
              context.report({ node, messageId: "unowned" });
              return;
            }
            if (
              !["query", "execute", "exec", "unsafe", "raw"].includes(
                method ?? "",
              )
            ) {
              return;
            }
            let source = sqlText(context, node.arguments.at(0));
            const parameters = initializerOf(context, node.arguments.at(1));
            if (
              source !== null &&
              parameters?.type === "ArrayExpression" &&
              Array.isArray(parameters.elements)
            ) {
              const elements = parameters.elements;
              const text = source.text;
              let replaced = plainSql("");
              let previous = 0;
              for (const match of text.matchAll(/\$(\d+)/gu)) {
                replaced = joinSql(
                  replaced,
                  plainSql(text.slice(previous, match.index)),
                );
                const argument = elements.at(Number(match.at(1)) - 1);
                const value = sqlText(context, argument);
                const visibility = nonprivateValue(context, argument);
                replaced = joinSql(
                  replaced,
                  value !== null && value.ownedIds.size > 0
                    ? value
                    : visibility === null
                      ? plainSql(match[0])
                      : plainSql(`'${visibility}'`),
                );
                previous = match.index + match[0].length;
              }
              source = joinSql(replaced, plainSql(text.slice(previous)));
            }
            reportSql(node, source);
          },
          TaggedTemplateExpression(node) {
            if (
              !isAstNode(node.parent) ||
              node.parent.type !== "CallExpression"
            ) {
              reportSql(node, sqlText(context, node));
            }
          },
        };
      },
    },
  },
});
