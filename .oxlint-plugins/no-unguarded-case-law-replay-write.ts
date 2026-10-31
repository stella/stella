import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Context } from "@oxlint/plugins";
import path from "node:path";

import { replayImportClosure } from "./case-law-replay-imports.ts";
import { REPLAY_WRITER_REGISTRY } from "./case-law-replay-writer-registry.ts";
import type { ReplayWriterOwner } from "./case-law-replay-writer-registry.ts";
import type { AstNode, ScopeContext } from "./utils.ts";
import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  memberPropertyName,
  resolveImportedExpressionForEnforcement,
  resolveVariable,
  stableInitializer,
  staticStringValue,
  unwrapExpression,
  writeSqlText,
} from "./utils.ts";

const OWNER = "apps/api/src/lib/case-law/replay-write.ts";
type ReplayContext = Context & ScopeContext;
type ReportWrite = (node: unknown) => void;
type PlanBinding = ReturnType<typeof planBinding>;

let closure: ReadonlySet<string> | undefined;
const fileIsReplayWriter = (filename: string) => {
  closure ??= replayImportClosure(path.resolve(import.meta.dir, ".."));
  return [...closure].some((file) => filename.endsWith(file));
};

const planOwnerCall = (context: ReplayContext, value: unknown) => {
  const expression = unwrapExpression(value);
  if (!isAstNode(expression) || expression.type !== "CallExpression") {
    return false;
  }
  const imported = resolveImportedExpressionForEnforcement(
    context,
    expression.callee,
  );
  return (
    imported?.source === "@/api/lib/case-law/replay-write" &&
    imported.imported === "replayWrite"
  );
};

const planBinding = (context: ReplayContext, value: unknown) => {
  const reference = unwrapExpression(value);
  if (!isIdentifierReference(reference)) {
    return null;
  }
  const variable = resolveVariable(context, reference);
  return variable !== null &&
    planOwnerCall(context, stableInitializer(variable))
    ? variable
    : null;
};

const rawQuery = (
  context: ReplayContext,
  value: unknown,
  seen = new Set<unknown>(),
): AstNode | null => {
  const expression = unwrapExpression(value);
  if (expression === null || seen.has(expression)) {
    return null;
  }
  seen.add(expression);
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(context, expression);
    return variable === null
      ? expression
      : rawQuery(context, stableInitializer(variable), seen);
  }
  if (
    expression.type === "MemberExpression" &&
    memberPropertyName(expression) === "sql"
  ) {
    return rawQuery(context, expression.object, seen);
  }
  if (
    expression.type === "CallExpression" &&
    isAstNode(expression.callee) &&
    memberPropertyName(expression.callee) === "sqlToQuery" &&
    Array.isArray(expression.arguments)
  ) {
    return rawQuery(context, expression.arguments.at(0), seen);
  }
  return expression;
};

const hasGuardedPredicate = (
  context: ReplayContext,
  value: unknown,
  binding: PlanBinding,
): boolean => {
  const expression = unwrapExpression(value);
  if (!isAstNode(expression) || binding === null) {
    return false;
  }
  if (
    expression.type === "MemberExpression" &&
    memberPropertyName(expression) === "setWhere" &&
    planBinding(context, expression.object) === binding
  ) {
    return true;
  }
  if (
    expression.type !== "CallExpression" ||
    !Array.isArray(expression.arguments)
  ) {
    return false;
  }
  const imported = resolveImportedExpressionForEnforcement(
    context,
    expression.callee,
  );
  return (
    imported?.source === "drizzle-orm" &&
    imported.imported === "and" &&
    expression.arguments.some((argument) =>
      hasGuardedPredicate(context, argument, binding),
    )
  );
};

const rawWriteCandidate = (text: string | null) =>
  text !== null &&
  /(?:^|[;(])\s*UPDATE\b|ON\s+CONFLICT[\s\S]*DO\s+UPDATE/iu.test(text);

const usesAssignmentsForBinding = (
  context: ReplayContext,
  expressions: unknown[],
  binding: NonNullable<PlanBinding>,
) =>
  expressions.some((assignmentExpression) => {
    const assignments = unwrapExpression(assignmentExpression);
    if (
      assignments?.type !== "CallExpression" ||
      !Array.isArray(assignments.arguments)
    ) {
      return false;
    }
    const imported = resolveImportedExpressionForEnforcement(
      context,
      assignments.callee,
    );
    return (
      imported?.source === "@/api/lib/case-law/replay-write" &&
      imported.imported === "replayWriteAssignments" &&
      planBinding(context, assignments.arguments.at(1)) === binding
    );
  });

const rawQueryIsGuarded = (
  context: ReplayContext,
  query: AstNode | null,
  text: string,
) => {
  if (
    query?.type !== "TaggedTemplateExpression" ||
    !isAstNode(query.quasi) ||
    !Array.isArray(query.quasi.expressions) ||
    /\bOR\b/iu.test(text)
  ) {
    return false;
  }
  const expressions = query.quasi.expressions;
  return expressions.some((predicateExpression) => {
    const predicate = unwrapExpression(predicateExpression);
    if (
      predicate?.type !== "MemberExpression" ||
      memberPropertyName(predicate) !== "setWhere"
    ) {
      return false;
    }
    const binding = planBinding(context, predicate.object);
    return (
      binding !== null &&
      usesAssignmentsForBinding(context, expressions, binding)
    );
  });
};

const handleRawWrite = (
  context: ReplayContext,
  node: AstNode,
  report: ReportWrite,
) => {
  const argument = Array.isArray(node.arguments)
    ? node.arguments.at(0)
    : undefined;
  const query = rawQuery(context, argument);
  const text = writeSqlText(context, query) ?? staticStringValue(query);
  if (rawWriteCandidate(text) && !rawQueryIsGuarded(context, query, text)) {
    report(node);
  }
};

const updateHasGuard = (
  context: ReplayContext,
  node: AstNode,
  plan: NonNullable<PlanBinding>,
) => {
  let chain = node.parent;
  while (
    isAstNode(chain) &&
    !["ExpressionStatement", "VariableDeclaration", "ReturnStatement"].includes(
      chain.type,
    )
  ) {
    if (
      chain.type === "CallExpression" &&
      isAstNode(chain.callee) &&
      getPropertyName(chain.callee.property) === "where" &&
      Array.isArray(chain.arguments) &&
      hasGuardedPredicate(context, chain.arguments.at(0), plan)
    ) {
      return true;
    }
    chain = chain.parent;
  }
  return false;
};

type DrizzleUpdateOptions = {
  context: ReplayContext;
  node: AstNode;
  callee: AstNode;
  method: string;
  report: ReportWrite;
};

const handleDrizzleUpdate = ({
  context,
  node,
  callee,
  method,
  report,
}: DrizzleUpdateOptions) => {
  const argumentsList = Array.isArray(node.arguments) ? node.arguments : [];
  const argument = unwrapExpression(argumentsList.at(0));
  if (method === "set") {
    const update = unwrapExpression(callee.object);
    if (
      !isAstNode(update) ||
      update.type !== "CallExpression" ||
      !isAstNode(update.callee) ||
      getPropertyName(update.callee.property) !== "update"
    ) {
      return;
    }
    if (
      !isAstNode(argument) ||
      argument.type !== "MemberExpression" ||
      getPropertyName(argument.property) !== "set"
    ) {
      report(node);
      return;
    }
    const plan = planBinding(context, argument.object);
    if (plan !== null && updateHasGuard(context, node, plan)) {
      return;
    }
  } else if (
    isAstNode(argument) &&
    argument.type === "ObjectExpression" &&
    Array.isArray(argument.properties) &&
    conflictUpdateHasGuard(context, argument.properties)
  ) {
    return;
  }
  report(node);
};

const conflictUpdateHasGuard = (
  context: ReplayContext,
  properties: unknown[],
) => {
  for (const property of properties) {
    if (!isAstNode(property) || property.type !== "SpreadElement") {
      continue;
    }
    const spread = unwrapExpression(property.argument);
    const binding = planBinding(context, spread);
    if (binding === null && !planOwnerCall(context, spread)) {
      continue;
    }
    const overrides = properties.filter(
      (candidate) =>
        isAstNode(candidate) &&
        candidate.type === "Property" &&
        ["set", "setWhere"].includes(getPropertyName(candidate.key) ?? ""),
    );
    if (
      overrides.every(
        (candidate) =>
          isAstNode(candidate) &&
          getPropertyName(candidate.key) === "setWhere" &&
          hasGuardedPredicate(context, candidate.value, binding),
      )
    ) {
      return true;
    }
  }
  return false;
};

const handleCall = (
  context: ReplayContext,
  input: unknown,
  report: ReportWrite,
) => {
  if (!isAstNode(input)) {
    return;
  }
  const node = input;
  const callee = unwrapExpression(node.callee);
  if (!isAstNode(callee) || callee.type !== "MemberExpression") {
    return;
  }
  const method = getPropertyName(callee.property);
  if (["execute", "query", "unsafe"].includes(method ?? "")) {
    handleRawWrite(context, node, report);
    return;
  }
  if (method === "set" || method === "onConflictDoUpdate") {
    handleDrizzleUpdate({ context, node, callee, method, report });
  }
};

const isReplayWriterFile = (filename: string) =>
  (filename.endsWith(
    ".oxlint-plugins/__fixtures__/no-unguarded-case-law-replay-write.fixture.ts",
  ) ||
    fileIsReplayWriter(filename)) &&
  !filename.endsWith(OWNER) &&
  !filename.endsWith(".test.ts");

export default eslintCompatPlugin({
  meta: { name: "no-unguarded-case-law-replay-write" },
  rules: {
    "no-unguarded-case-law-replay-write": {
      meta: {
        type: "problem",
        schema: [
          {
            type: "object",
            properties: { mode: { enum: ["enforce", "audit"] } },
            additionalProperties: false,
          },
        ],
        messages: {
          unguarded:
            "Derive the replay SET and distinctness predicate together with replayWrite; apply its setWhere in the same mutation.",
        },
      },
      createOnce(context) {
        const report: ReportWrite = (input) => {
          if (!isAstNode(input)) {
            return;
          }
          const node = input;
          const option = context.options.at(0);
          const mode =
            typeof option === "object" && option !== null && "mode" in option
              ? option.mode
              : "enforce";
          const filename = filenameForContext(context);
          const line = context.sourceCode.getLocFromIndex(node.range[0]).line;
          const owners: readonly ReplayWriterOwner[] = REPLAY_WRITER_REGISTRY;
          const registered = owners.find(
            (owner) => filename.endsWith(owner.file) && owner.line === line,
          );
          if (mode !== "audit" && registered !== undefined) {
            return;
          }
          context.report({ node, messageId: "unguarded" });
        };
        return {
          before() {
            return isReplayWriterFile(filenameForContext(context));
          },
          ReturnStatement(node) {
            const value = unwrapExpression(node.argument);
            if (
              isAstNode(value) &&
              value.type === "ObjectExpression" &&
              Array.isArray(value.properties)
            ) {
              const keys = value.properties.map((property) =>
                isAstNode(property) && property.type === "Property"
                  ? getPropertyName(property.key)
                  : null,
              );
              if (keys.includes("set") && keys.includes("where")) {
                report(node);
              }
            }
          },
          CallExpression(node) {
            handleCall(context, node, report);
          },
        };
      },
    },
  },
});
