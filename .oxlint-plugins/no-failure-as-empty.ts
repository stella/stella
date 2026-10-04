// A failed read must not be handed back as an empty value. `[]`, `null`,
// `undefined`, `{}`, `false`, `0` and `""` all read as "the source holds
// nothing", so a caller stores, renders or acts on an absence the source never
// stated. Return a `ReadOutcome` (`@/api/lib/errors/read-outcome`; case-law
// adapters read through `readPublisher`) or let the failure propagate.
//
// Reported shapes (each counted per enclosing named function):
// - `catch-returns-empty`: a catch clause around an asynchronous try block
//   with any path returning an empty value (rethrowing only a cancellation
//   still turns every other failure into "nothing"). A synchronous try block
//   is parsing, not reading, and is exempt.
// - `promise-catch-empty`: `.catch(fn)` whose handler returns an empty value,
//   or swallows the failure while the promise's value is used.
// - `result-catch-empty`: a `Result.tryPromise` `catch` mapping the failure
//   to an empty value (`Result.try` is synchronous parsing and is exempt).
// - `not-ok-returns-empty`: `if (!response.ok)`, a non-success status
//   comparison, or `status === 204`, whose branch returns an empty value.
// - `result-error-returns-empty`: `if (Result.isError(x))` / `x.isErr()`
//   inside an async function, whose branch returns an empty value.
//
// Existing sites are held to an exact-set baseline that only shrinks
// (`scripts/failure-as-empty-baseline.ts`).

import { eslintCompatPlugin } from "@oxlint/plugins";

import baseline from "./no-failure-as-empty-baseline.json" with { type: "json" };
import {
  isAstNode,
  isIdentifier,
  isMemberAccess,
  memberPropertyName,
  repoRelativeFilename,
  unwrapExpression,
  type AstNode,
} from "./utils.ts";

const RULE_NAME = "no-failure-as-empty";

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);
const BOUNDARY_TYPES = new Set([
  ...FUNCTION_TYPES,
  "ClassDeclaration",
  "ClassExpression",
]);

type Shape =
  | "catch-returns-empty"
  | "promise-catch-empty"
  | "result-catch-empty"
  | "not-ok-returns-empty"
  | "result-error-returns-empty";

const children = (node: AstNode): AstNode[] =>
  Object.entries(node).flatMap(([key, value]) => {
    if (key === "parent") {
      return [];
    }
    const items: unknown[] = Array.isArray(value) ? value : [value];
    return items.filter(isAstNode);
  });

/** Every node under `root` that belongs to the same function body. */
const ownNodes = (root: unknown): AstNode[] => {
  const out: AstNode[] = [];
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!isAstNode(current)) {
      continue;
    }
    out.push(current);
    for (const child of children(current)) {
      if (!BOUNDARY_TYPES.has(child.type)) {
        pending.push(child);
      }
    }
  }
  return out;
};

/** A value that reads as "nothing here". */
const isEmptyValue = (node: unknown): boolean => {
  const value = unwrapExpression(node);
  if (value === null) {
    return false;
  }
  if (isIdentifier(value, "undefined")) {
    return true;
  }
  switch (value.type) {
    case "Literal":
      return (
        (value.value === null ||
          value.value === false ||
          value.value === 0 ||
          value.value === "") &&
        !("regex" in value && value.regex !== undefined)
      );
    case "ArrayExpression":
      return Array.isArray(value.elements) && value.elements.length === 0;
    case "ObjectExpression":
      return (
        Array.isArray(value.properties) &&
        value.properties.every(
          (property) =>
            isAstNode(property) &&
            property.type === "Property" &&
            isEmptyValue(property.value),
        )
      );
    case "NewExpression":
      return (
        (isIdentifier(value.callee, "Map") ||
          isIdentifier(value.callee, "Set")) &&
        Array.isArray(value.arguments) &&
        value.arguments.length === 0
      );
    case "CallExpression": {
      // `c.json([])`, `Response.json({ items: [] })`
      const callee = unwrapExpression(value.callee);
      return (
        callee?.type === "MemberExpression" &&
        memberPropertyName(callee) === "json" &&
        Array.isArray(value.arguments) &&
        value.arguments.length >= 1 &&
        isEmptyValue(value.arguments.at(0))
      );
    }
    default:
      return false;
  }
};

const returnsOf = (root: unknown) =>
  ownNodes(root).filter((node) => node.type === "ReturnStatement");

const throwsWithin = (root: unknown) =>
  ownNodes(root).some((node) => node.type === "ThrowStatement");

const returnsEmpty = (root: unknown) =>
  returnsOf(root).some((statement) => isEmptyValue(statement.argument));

/** The then-branch's own statements, without descending into nested blocks. */
const branchStatements = (branch: unknown): AstNode[] => {
  if (!isAstNode(branch)) {
    return [];
  }
  return branch.type === "BlockStatement" && Array.isArray(branch.body)
    ? branch.body.filter(isAstNode)
    : [branch];
};

const branchReturnsEmpty = (branch: unknown) => {
  const statements = branchStatements(branch);
  return (
    !statements.some((statement) => statement.type === "ThrowStatement") &&
    statements.some(
      (statement) =>
        statement.type === "ReturnStatement" &&
        isEmptyValue(statement.argument),
    )
  );
};

const isAsynchronous = (root: unknown) =>
  ownNodes(root).some(
    (node) =>
      node.type === "AwaitExpression" ||
      node.type === "YieldExpression" ||
      (node.type === "ForOfStatement" && node.await === true) ||
      (node.type === "CallExpression" &&
        isAstNode(node.callee) &&
        node.callee.type === "MemberExpression" &&
        memberPropertyName(node.callee) === "then"),
  );

const isStatusMember = (node: unknown) => {
  const member = unwrapExpression(node);
  if (member?.type !== "MemberExpression") {
    return false;
  }
  const name = memberPropertyName(member);
  return name === "status" || name === "statusCode";
};

const isNumber = (node: unknown, value?: number) => {
  const literal = unwrapExpression(node);
  return (
    literal?.type === "Literal" &&
    typeof literal.value === "number" &&
    (value === undefined || literal.value === value)
  );
};

/** Publisher-stated absence: an empty result is the truthful outcome. */
const ABSENCE_STATUSES = new Set([404, 410]);

/** 204, or any 4xx/5xx other than a stated absence. */
const isFailureStatus = (node: unknown) => {
  const literal = unwrapExpression(node);
  if (literal?.type !== "Literal" || typeof literal.value !== "number") {
    return false;
  }
  const status = literal.value;
  return status === 204 || (status >= 400 && !ABSENCE_STATUSES.has(status));
};

/**
 * `!res.ok`, `res.status !== 200`, `res.status >= 400`, and equality with a
 * failure status (`res.status === 500`, `=== 204`).
 */
const isFailedResponseTest = (test: unknown): boolean => {
  const node = unwrapExpression(test);
  if (node === null) {
    return false;
  }
  if (node.type === "LogicalExpression") {
    return isFailedResponseTest(node.left) || isFailedResponseTest(node.right);
  }
  if (node.type === "UnaryExpression" && node.operator === "!") {
    const argument = unwrapExpression(node.argument);
    return (
      argument?.type === "MemberExpression" &&
      memberPropertyName(argument) === "ok"
    );
  }
  if (node.type !== "BinaryExpression") {
    return false;
  }
  const operator = String(node.operator);
  const [status, number] = isStatusMember(node.left)
    ? [node.left, node.right]
    : [node.right, node.left];
  if (!isStatusMember(status) || !isNumber(number)) {
    return false;
  }
  if (operator === "===" || operator === "==") {
    return isFailureStatus(number);
  }
  return ["!==", "!=", ">=", ">", "<"].includes(operator);
};

const isResultErrorTest = (test: unknown): boolean => {
  const node = unwrapExpression(test);
  if (node?.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(node.callee);
  return (
    isMemberAccess(callee, "Result", "isError") ||
    (callee?.type === "MemberExpression" &&
      memberPropertyName(callee) === "isErr")
  );
};

const isFunction = (node: unknown): node is AstNode =>
  isAstNode(node) && FUNCTION_TYPES.has(node.type);

/** Whether a handler maps its failure to an empty value. */
const handlerReturnsEmpty = (handler: AstNode) =>
  isAstNode(handler.body) && handler.body.type !== "BlockStatement"
    ? isEmptyValue(handler.body)
    : returnsEmpty(handler.body);

const swallows = (handler: AstNode) =>
  isAstNode(handler.body) &&
  handler.body.type === "BlockStatement" &&
  !throwsWithin(handler.body) &&
  returnsOf(handler.body).length === 0;

/** Whether the value of `node` is used rather than discarded. */
const isValueUsed = (node: AstNode): boolean => {
  let current: AstNode = node;
  let parent = current.parent;
  while (
    isAstNode(parent) &&
    (parent.type === "AwaitExpression" ||
      parent.type === "ParenthesizedExpression" ||
      parent.type === "TSAsExpression" ||
      parent.type === "TSNonNullExpression" ||
      parent.type === "ChainExpression")
  ) {
    current = parent;
    parent = current.parent;
  }
  if (!isAstNode(parent)) {
    return false;
  }
  if (parent.type === "ExpressionStatement") {
    return false;
  }
  return !(parent.type === "UnaryExpression" && parent.operator === "void");
};

const functionName = (fn: AstNode): string | null => {
  if (isIdentifier(fn.id)) {
    return fn.id.name;
  }
  let parent = fn.parent;
  // `const read = memo(async () => …)`: the name sits past the wrapping call.
  while (isAstNode(parent) && parent.type === "CallExpression") {
    parent = parent.parent;
  }
  if (!isAstNode(parent)) {
    return null;
  }
  if (parent.type === "VariableDeclarator" && isIdentifier(parent.id)) {
    return parent.id.name;
  }
  if (
    (parent.type === "Property" ||
      parent.type === "MethodDefinition" ||
      parent.type === "PropertyDefinition") &&
    parent.computed !== true
  ) {
    const key = parent.key;
    // `Result.tryPromise({ try, catch })` callbacks belong to their caller.
    if (isIdentifier(key) && (key.name === "try" || key.name === "catch")) {
      return null;
    }
    if (isIdentifier(key)) {
      return key.name;
    }
    if (isAstNode(key) && key.type === "Literal") {
      return String(key.value);
    }
  }
  return null;
};

/** The nearest named function around `node`; callbacks fold into it. */
const ownerName = (node: AstNode): string => {
  let current = node.parent;
  while (isAstNode(current)) {
    const next = current.parent;
    if (isFunction(current)) {
      const name = functionName(current);
      if (name !== null) {
        return name;
      }
    }
    current = next;
  }
  return "<module>";
};

/** Reads are asynchronous; a synchronous function's Result is a parse. */
const insideAsyncFunction = (node: AstNode): boolean => {
  let current = node.parent;
  while (isAstNode(current)) {
    const next = current.parent;
    if (isFunction(current)) {
      return current.async === true;
    }
    current = next;
  }
  return false;
};

type Finding = { node: AstNode; shape: Shape };

const findingFor = (node: AstNode): Finding | null => {
  switch (node.type) {
    case "CatchClause": {
      const statement = node.parent;
      if (
        !isAstNode(statement) ||
        statement.type !== "TryStatement" ||
        !isAsynchronous(statement.block) ||
        !returnsEmpty(node.body)
      ) {
        return null;
      }
      return { node, shape: "catch-returns-empty" };
    }
    case "IfStatement": {
      if (!branchReturnsEmpty(node.consequent)) {
        return null;
      }
      if (isFailedResponseTest(node.test)) {
        return { node, shape: "not-ok-returns-empty" };
      }
      if (isResultErrorTest(node.test) && insideAsyncFunction(node)) {
        return { node, shape: "result-error-returns-empty" };
      }
      return null;
    }
    case "CallExpression": {
      const callee = unwrapExpression(node.callee);
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      if (
        callee?.type === "MemberExpression" &&
        memberPropertyName(callee) === "catch" &&
        args.length === 1
      ) {
        const handler = args.at(0);
        if (
          isFunction(handler) &&
          (handlerReturnsEmpty(handler) ||
            (swallows(handler) && isValueUsed(node)))
        ) {
          return { node, shape: "promise-catch-empty" };
        }
        return null;
      }
      if (isMemberAccess(callee, "Result", "tryPromise")) {
        const options = unwrapExpression(args.at(0));
        if (options?.type !== "ObjectExpression") {
          return null;
        }
        const handler = (
          Array.isArray(options.properties) ? options.properties : []
        ).find(
          (property): property is AstNode =>
            isAstNode(property) &&
            property.type === "Property" &&
            isIdentifier(property.key, "catch"),
        )?.value;
        return isFunction(handler) && handlerReturnsEmpty(handler)
          ? { node, shape: "result-catch-empty" }
          : null;
      }
      return null;
    }
    default:
      return null;
  }
};

const entries: Readonly<Record<string, string>> = baseline.entries;

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          failureAsEmpty:
            "A failed read is returned as an empty value, which callers cannot tell apart from a source that holds nothing. Return a ReadOutcome from @/api/lib/errors/read-outcome (case-law adapters: readPublisher), or let the failure propagate. Failure-as-empty site: {{key}}.",
        },
        schema: [
          {
            type: "object",
            properties: { census: { type: "boolean" } },
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
        const findings: Finding[] = [];
        const collect = (node: unknown) => {
          if (!isAstNode(node)) {
            return;
          }
          const finding = findingFor(node);
          if (finding !== null) {
            findings.push(finding);
          }
        };
        return {
          before() {
            findings.length = 0;
          },
          CatchClause: collect,
          IfStatement: collect,
          CallExpression: collect,
          "Program:exit"() {
            const options = context.options.at(0);
            const census =
              typeof options === "object" &&
              options !== null &&
              Reflect.get(options, "census") === true;
            const file = repoRelativeFilename(context);
            const ordinals = new Map<string, number>();
            const ordered = findings.toSorted(
              (left, right) => left.node.range[0] - right.node.range[0],
            );
            for (const { node, shape } of ordered) {
              const site = `${file}::${ownerName(node)}::${shape}`;
              const ordinal = (ordinals.get(site) ?? 0) + 1;
              ordinals.set(site, ordinal);
              const key = `${site}#${String(ordinal)}`;
              if (!census && Object.hasOwn(entries, key)) {
                continue;
              }
              context.report({
                node,
                messageId: "failureAsEmpty",
                data: { key },
              });
            }
          },
        };
      },
    },
  },
});
