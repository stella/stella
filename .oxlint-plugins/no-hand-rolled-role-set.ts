// Read a set of organization roles from `@stll/permissions`, never spell it.
//
// "Owner or admin" means two different things in the product: the roles that
// manage the firm (`ORGANIZATION_MANAGEMENT_ROLES`) and the roles that reach
// every client matter without an assignment (`CLIENT_MATTER_ADMIN_ROLES`).
// Both are `owner` and `admin` today. A copy of either list in a query, a
// guard or a component keeps its old members when the owner changes, so one
// path grants what another refuses, and nothing fails until someone notices
// the two disagree.
//
// `packages/auth-model/src/contract.ts` owns the role names and
// `packages/permissions/src/index.ts` owns the named role sets; only those
// two files may list roles. The role names below come from the contract
// itself, so a new role is covered without editing this rule.
//
// Flagged (in production sources under apps/*/src and packages/*/src):
//   role === "owner" || role === "admin"
//   role !== "owner" && role !== "admin"
//   ["owner", "admin"].includes(role)
//   new Set(["admin", "member"])
//   sql`... m.role IN ('owner', 'admin') ...`
//   sql`... role = ANY (ARRAY['owner','admin']) ...`
//
// Allowed:
//   CLIENT_MATTER_ADMIN_ROLES.some((role) => role === actorRole)
//   isOrganizationManagementRole(role)
//   role !== "owner" || actorRole === "owner"   // two operands, not a set
//   role === "owner"                            // one role is not a set
//   ["owner", "draft"]                          // not every element is a role
//
// Detection boundary: a set is two or more distinct role names compared with
// the same operand (by source text), an array literal made only of role
// names, or two quoted role names adjacent in a comma list of SQL text. A
// list assembled through variables or a single role tested at a time is not
// matched. Tests are out of scope: a role matrix there is the oracle.

import { eslintCompatPlugin, type Node } from "@oxlint/plugins";

import { ORGANIZATION_ROLE_NAMES } from "../packages/auth-model/src/contract.ts";
import {
  type AstNode,
  filenameForContext,
  isAstNode,
  isStringLiteral,
  isTestFile,
} from "./utils.ts";

const RULE_NAME = "no-hand-rolled-role-set";

const OWNING_MODULES = [
  "packages/auth-model/src/contract.ts",
  "packages/permissions/src/index.ts",
];
const FIXTURE = `.oxlint-plugins/__fixtures__/${RULE_NAME}.fixture.ts`;
const PRODUCTION_SOURCE = /(?:^|\/)(?:apps|packages)\/[^/]+\/src\//u;

const ROLE_NAMES: ReadonlySet<string> = new Set(ORGANIZATION_ROLE_NAMES);
const ROLE_ALTERNATION = ORGANIZATION_ROLE_NAMES.join("|");

// Two quoted role names in one comma list: `IN ('owner', 'admin')`,
// `ARRAY['owner','admin']`. Casts between them (`'owner'::text`) are what
// Postgres prints back for a view definition, so they are allowed for.
const SQL_ROLE_LIST = new RegExp(
  String.raw`'(?:${ROLE_ALTERNATION})'(?:::\w+)?\s*,\s*'(?:${ROLE_ALTERNATION})'`,
  "u",
);

const roleLiteral = (node: unknown): string | null =>
  isStringLiteral(node) && ROLE_NAMES.has(node.value) ? node.value : null;

type RoleComparison = { operand: string; role: string };

/**
 * `<operand> <operator> "<role>"` in either order, with the operand's source
 * text so two comparisons can be matched to the same value.
 */
const roleComparison = (
  node: unknown,
  operator: "===" | "!==",
  textOf: (node: AstNode) => string,
): RoleComparison | null => {
  if (
    !isAstNode(node) ||
    node.type !== "BinaryExpression" ||
    node.operator !== operator
  ) {
    return null;
  }
  const { left, right } = node;
  if (!isAstNode(left) || !isAstNode(right)) {
    return null;
  }
  const rightRole = roleLiteral(right);
  if (rightRole !== null && roleLiteral(left) === null) {
    return { operand: textOf(left), role: rightRole };
  }
  const leftRole = roleLiteral(left);
  if (leftRole !== null && rightRole === null) {
    return { operand: textOf(right), role: leftRole };
  }
  return null;
};

/** The leaves of a chain of one logical operator, left to right. */
const logicalLeaves = (node: unknown, operator: string): unknown[] => {
  if (
    isAstNode(node) &&
    node.type === "LogicalExpression" &&
    node.operator === operator
  ) {
    return [
      ...logicalLeaves(node.left, operator),
      ...logicalLeaves(node.right, operator),
    ];
  }
  return [node];
};

/** Whether `||` of `===` (or `&&` of `!==`) tests one operand for 2+ roles. */
const comparesOperandWithRoleSet = (
  node: unknown,
  textOf: (node: AstNode) => string,
): boolean => {
  if (!isAstNode(node) || node.type !== "LogicalExpression") {
    return false;
  }
  const operator =
    node.operator === "||" ? "||" : node.operator === "&&" ? "&&" : null;
  if (operator === null) {
    return false;
  }
  const comparison = operator === "||" ? "===" : "!==";
  const rolesByOperand = new Map<string, Set<string>>();
  for (const leaf of logicalLeaves(node, operator)) {
    const match = roleComparison(leaf, comparison, textOf);
    if (match === null) {
      continue;
    }
    const roles = rolesByOperand.get(match.operand) ?? new Set<string>();
    roles.add(match.role);
    rolesByOperand.set(match.operand, roles);
  }
  return [...rolesByOperand.values()].some((roles) => roles.size >= 2);
};

/** An array literal of two or more elements, every one a role name. */
const isRoleArray = (node: unknown): boolean => {
  if (
    !isAstNode(node) ||
    node.type !== "ArrayExpression" ||
    !Array.isArray(node.elements)
  ) {
    return false;
  }
  const { elements } = node;
  return (
    elements.length >= 2 &&
    elements.every((element) => roleLiteral(element) !== null)
  );
};

// A quasi's `value` is a plain `{ raw, cooked }` record rather than an AST
// node, so it carries no `type` to narrow on and needs a guard of its own.
const holdsRawText = (value: unknown): value is { raw: string } =>
  typeof value === "object" &&
  value !== null &&
  "raw" in value &&
  typeof value.raw === "string";

const rawTextOf = (quasi: unknown): string => {
  const value = isAstNode(quasi) ? quasi.value : undefined;
  return holdsRawText(value) ? value.raw : "";
};

/**
 * The parent `LogicalExpression` of the same operator, so a chain is reported
 * once at its root rather than at every nested pair.
 */
const continuesChain = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const { parent } = node;
  return (
    isAstNode(parent) &&
    parent.type === "LogicalExpression" &&
    parent.operator === node.operator
  );
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          handRolledRoleSet:
            "Read this role set from `@stll/permissions` " +
            "(`ORGANIZATION_MANAGEMENT_ROLES`, `CLIENT_MATTER_ADMIN_ROLES`, " +
            "`isOrganizationManagementRole`) instead of listing roles. A " +
            "copied list keeps its old members when the owner changes.",
        },
      },
      createOnce(context) {
        const textOf = ({ range: [start, end] }: AstNode): string =>
          context.sourceCode.text.slice(start, end);
        const report = (node: Node) =>
          context.report({ node, messageId: "handRolledRoleSet" });

        return {
          before() {
            const filename = filenameForContext(context);
            if (filename.endsWith(FIXTURE)) {
              return true;
            }
            return (
              PRODUCTION_SOURCE.test(filename) &&
              !isTestFile(filename) &&
              !OWNING_MODULES.some((owner) => filename.endsWith(owner))
            );
          },
          LogicalExpression(node) {
            if (
              !continuesChain(node) &&
              comparesOperandWithRoleSet(node, textOf)
            ) {
              report(node);
            }
          },
          ArrayExpression(node) {
            if (isRoleArray(node)) {
              report(node);
            }
          },
          Literal(node) {
            if (
              typeof node.value === "string" &&
              SQL_ROLE_LIST.test(node.value)
            ) {
              report(node);
            }
          },
          TemplateLiteral(node) {
            const quasis = Array.isArray(node.quasis) ? node.quasis : [];
            if (quasis.some((quasi) => SQL_ROLE_LIST.test(rawTextOf(quasi)))) {
              report(node);
            }
          },
        };
      },
    },
  },
});
