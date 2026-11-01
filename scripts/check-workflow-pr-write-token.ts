#!/usr/bin/env bun

import { TaggedError } from "better-result";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

class WorkflowPrivilegePolicyError extends TaggedError(
  "WorkflowPrivilegePolicyError",
)<{ message: string; file: string }> {}

type Finding = {
  file: string;
  job: string;
  step: string;
  class: "class 1" | "class 2" | "class 3";
  trigger: string;
};

type FindingKey = `${Finding["class"]}:${string}`;

type ExemptionCondition =
  /** Each fragment must be a top-level conjunct of the job condition. */
  | { conjuncts: readonly [string, ...string[]] }
  /** Why the exemption holds whatever the job condition says. */
  | { unconditional: string };

type ExemptionPrivileges = {
  /** Permission scopes the job may hold with write access. */
  write: readonly string[];
  /** Repository secrets the job may reference, by name. */
  secrets: readonly string[];
};

type WorkflowPrivilegeExemption = {
  reason: string;
  /** The findings the reason covers; any other finding on the job is reported. */
  covers: readonly [FindingKey, ...FindingKey[]];
  /** The job condition the reason depends on; without it the exemption lapses. */
  requires: ExemptionCondition;
  /** The privileges the reason was approved for; any other privilege lapses it. */
  privileges: ExemptionPrivileges;
  /**
   * The workflow a job-level `uses` calls, pinned to a commit. Any other
   * called workflow, and any remote one without a pin, lapses the exemption.
   */
  calls?: string;
};

const CI_PLAN_REASON =
  "pull-request credentials are platform-downgraded or admitted by the trusted CI plan";
const CI_PLAN_TRUSTED = {
  conjuncts: ["needs.ci-plan.outputs.trusted == 'true'"],
} as const;
const RELEASE_SHOULD_BUILD = {
  conjuncts: ["needs.resolve.outputs.should_build == 'true'"],
} as const;
const PULL_REQUEST_DEPENDABOT = ["class 3:pull_request"] as const;
const PULL_REQUEST_SECRET = [
  "class 2:pull_request",
  "class 3:pull_request",
] as const;
const WORKFLOW_RUN_WRITE = ["class 1:workflow_run"] as const;
const ACTIONS_WRITE = { write: ["actions"], secrets: [] } as const;
const ACTIONS_WRITE_REGISTRY = {
  write: ["actions"],
  secrets: ["DOCKERHUB_TOKEN", "DOCKERHUB_USERNAME"],
} as const;

export const WORKFLOW_PRIVILEGE_ALLOWLIST = {
  ".github/workflows/ci.yml:api-image-smoke": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:ci-browser": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: {
      unconditional:
        "the job only reads the results the admitted browser jobs uploaded",
    },
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:ci-checks-generated": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:ci-checks-policy": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:ci-checks-rest": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:ci-plan": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: {
      unconditional:
        "the job decides trust itself and holds only the actions scope it needs to record that decision",
    },
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:ci-result": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: {
      unconditional:
        "the job only aggregates the results of the other jobs in the run",
    },
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:marketing-screenshots": {
    reason:
      "registry pull credentials reach the reusable capture only when the trusted CI plan admits the run",
    covers: PULL_REQUEST_SECRET,
    requires: CI_PLAN_TRUSTED,
    privileges: {
      write: [],
      secrets: ["DOCKERHUB_TOKEN", "DOCKERHUB_USERNAME"],
    },
  },
  ".github/workflows/ci.yml:ci-tests": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:code-quality-api": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:code-quality-web-rest": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:dependency-malware": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:desktop-rust-lint": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:desktop-rust-tests": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:desktop-windows-dry-run": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:e2e-landing": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:e2e-production-shard": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_SECRET,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE_REGISTRY,
  },
  ".github/workflows/ci.yml:e2e-report": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: {
      unconditional:
        "the job only merges the reports the admitted end-to-end shards uploaded",
    },
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:e2e-vite-canary": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_SECRET,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE_REGISTRY,
  },
  ".github/workflows/ci.yml:generated-sources": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:landing-build": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:legal-atlas-image": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:migration-upgrade-rehearsal": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:mobile-build": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:postgres-service-suites": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:release-typecheck": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:route-smoke": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_SECRET,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE_REGISTRY,
  },
  ".github/workflows/ci.yml:scan-engine-wasm-drift": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:service-suites": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:stack-redaction-browsers": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:web-build": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:web-image-smoke": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:windows-scripts": {
    reason: CI_PLAN_REASON,
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/pr-lint.yml:pr-lint": {
    reason:
      "the pinned called workflow only reads pull-request metadata through the API and never checks out or runs pull-request code",
    covers: ["class 1:pull_request_target"],
    requires: {
      unconditional:
        "the approval rests on the pinned called workflow, not on the job condition",
    },
    calls:
      "stella/.github/.github/workflows/pr-lint.yml@5764ab66e4df84cfd2e642c7d7e4678261e668f8",
    privileges: { write: ["pull-requests"], secrets: [] },
  },
  ".github/workflows/publish-npm.yml:release-*": {
    reason:
      "a workflow_run publishes only for this repository's release workflow started by a push or dispatch, after release-trigger checks the tag, the receipt and that protected main carries the release commit, and pack succeeds from it",
    covers: WORKFLOW_RUN_WRITE,
    requires: {
      conjuncts: [
        "needs.pack.result == 'success'",
        "github.event.workflow_run.head_repository.full_name == github.repository",
        "github.event.workflow_run.path == '.github/workflows/release.yml'",
        `contains(fromJSON('["push", "workflow_dispatch"]'), github.event.workflow_run.event)`,
      ],
    },
    calls:
      "stella/.github/.github/workflows/npm-independent-release.yml@042baebaf071329b956555c05caf5736504c278d",
    privileges: {
      write: ["contents", "id-token"],
      secrets: ["STELLA_RELEASE_APP_ID", "STELLA_RELEASE_APP_PRIVATE_KEY"],
    },
  },
  ".github/workflows/release-desktop.yml:build": {
    reason:
      "the workflow_run release reference is resolved and admitted from the trusted release workflow",
    covers: WORKFLOW_RUN_WRITE,
    requires: RELEASE_SHOULD_BUILD,
    privileges: {
      write: ["contents"],
      secrets: [
        "APPLE_API_ISSUER",
        "APPLE_API_KEY",
        "APPLE_API_KEY_ID",
        "APPLE_CERTIFICATE",
        "APPLE_CERTIFICATE_PASSWORD",
        "APPLE_SIGNING_IDENTITY",
        "APPLE_TEAM_ID",
        "AZURE_CERT_PROFILE",
        "AZURE_CLIENT_ID",
        "AZURE_CLIENT_SECRET",
        "AZURE_CODE_SIGNING_ACCOUNT",
        "AZURE_ENDPOINT",
        "AZURE_TENANT_ID",
        "TAURI_SIGNING_PRIVATE_KEY",
        "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
        "VITE_POSTHOG_KEY",
      ],
    },
  },
  ".github/workflows/release-desktop.yml:manifest": {
    reason:
      "the workflow_run release reference is resolved and admitted from the trusted release workflow",
    covers: WORKFLOW_RUN_WRITE,
    requires: RELEASE_SHOULD_BUILD,
    privileges: {
      write: ["contents", "id-token"],
      secrets: ["AWS_ROLE_ARN_DEPLOY"],
    },
  },
  ".github/workflows/ci.yml:database-migrations-check": {
    reason: "ci-plan trusted is false for Dependabot pull requests",
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
  ".github/workflows/ci.yml:database-migrations-apply-fresh": {
    reason: "ci-plan trusted is false for Dependabot pull requests",
    covers: PULL_REQUEST_DEPENDABOT,
    requires: CI_PLAN_TRUSTED,
    privileges: ACTIONS_WRITE,
  },
} as const satisfies Record<string, WorkflowPrivilegeExemption>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string => JSON.stringify(value ?? "");
const stringsOf = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsOf);
  }
  return record(value) ? Object.values(value).flatMap(stringsOf) : [];
};
const stringField = (value: unknown): string =>
  typeof value === "string" ? value : "";

// Actions evaluates only `${{ … }}` bodies. A `}}` inside a single-quoted
// literal does not close one (`''` escapes a quote, so toggling suffices),
// and an unclosed body runs to the end of the value.
const expressionEnd = (value: string, start: number): number => {
  let index = start + 3;
  let quoted = false;
  while (index < value.length && (quoted || !value.startsWith("}}", index))) {
    if (value.charAt(index) === "'") {
      quoted = !quoted;
    }
    index += 1;
  }
  return index;
};
const expressionBodies = (value: string): string[] => {
  const bodies: string[] = [];
  let start = value.indexOf("${{");
  while (start !== -1) {
    const end = expressionEnd(value, start);
    bodies.push(value.slice(start + 3, end));
    start = value.indexOf("${{", end);
  }
  return bodies;
};
// A value is one expression only when a single closed `${{ … }}` spans all
// of it; any other text around it makes the whole value a non-empty string.
const soleExpressionBody = (value: string): string | undefined => {
  if (!value.startsWith("${{")) {
    return undefined;
  }
  const end = expressionEnd(value, 0);
  return end + 2 === value.length ? value.slice(3, end) : undefined;
};

// ---------------------------------------------------------------------------
// Expressions

type Expression =
  | { type: "boolean"; value: boolean }
  | { type: "string"; value: string }
  | { type: "number"; value: string }
  | { type: "null" }
  | { type: "identifier"; name: string }
  | { type: "member"; target: Expression; name: string }
  | { type: "index"; target: Expression; index: Expression }
  | { type: "call"; name: string; args: Expression[] }
  | { type: "not"; operand: Expression }
  | {
      type: "binary";
      operator: "&&" | "||" | "==" | "!=" | "<" | "<=" | ">" | ">=";
      left: Expression;
      right: Expression;
    };

// Whitespace is skipped by the scanner, not by the pattern, so the sticky
// match stays linear. Only single quotes delimit strings in Actions.
const EXPRESSION_TOKEN =
  /&&|\|\||==|!=|<=|>=|[<>!()[\],.*]|'(?:[^']|'')*'|0x[0-9A-Fa-f]+|[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|[A-Za-z_][A-Za-z0-9_-]*/uy;

const expressionTokens = (source: string): string[] | undefined => {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    if (/\s/u.test(source.charAt(index))) {
      index += 1;
      continue;
    }
    EXPRESSION_TOKEN.lastIndex = index;
    const match = EXPRESSION_TOKEN.exec(source);
    if (match === null) {
      return undefined;
    }
    tokens.push(match[0]);
    index = EXPRESSION_TOKEN.lastIndex;
  }
  return tokens;
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

type BinaryOperator = Extract<Expression, { type: "binary" }>["operator"];
const BINARY_OPERATORS: readonly BinaryOperator[] = [
  "&&",
  "||",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
];
const isBinaryOperator = (token: string | undefined): token is BinaryOperator =>
  BINARY_OPERATORS.some((operator) => operator === token);

// A recursive-descent parser in Actions precedence order. Any syntax it does
// not model fails the whole parse, so callers treat the value as unknown.
const parseExpression = (source: string): Expression | undefined => {
  const tokens = expressionTokens(source);
  if (tokens === undefined || tokens.length === 0) {
    return undefined;
  }
  let cursor = 0;
  let failed = false;
  const INVALID: Expression = { type: "null" };
  // Read through a call: the flag is set inside the nested parsers.
  const parsing = (): boolean => !failed;
  const peek = (): string | undefined => tokens.at(cursor);
  const take = (expected?: string): string => {
    const token = tokens.at(cursor);
    if (token === undefined || (expected !== undefined && token !== expected)) {
      failed = true;
      return "";
    }
    cursor += 1;
    return token;
  };
  const binaryLevel =
    (
      operators: readonly BinaryOperator[],
      operand: () => Expression,
    ): (() => Expression) =>
    () => {
      let left = operand();
      let operator = peek();
      while (
        parsing() &&
        isBinaryOperator(operator) &&
        operators.includes(operator)
      ) {
        take();
        left = { type: "binary", operator, left, right: operand() };
        operator = peek();
      }
      return left;
    };
  const parseCall = (name: string): Expression => {
    take("(");
    const args: Expression[] = [];
    if (peek() !== ")") {
      args.push(parseOr());
      while (parsing() && peek() === ",") {
        take(",");
        args.push(parseOr());
      }
    }
    take(")");
    return { type: "call", name, args };
  };
  const parsePrimary = (): Expression => {
    const token = take();
    if (token === "(") {
      const inner = parseOr();
      take(")");
      return inner;
    }
    if (token.startsWith("'")) {
      return {
        type: "string",
        value: token.slice(1, -1).replaceAll("''", "'"),
      };
    }
    if (/^[0-9]/u.test(token)) {
      return { type: "number", value: token };
    }
    if (!IDENTIFIER.test(token)) {
      failed = true;
      return INVALID;
    }
    const lower = token.toLowerCase();
    if (peek() === "(") {
      return parseCall(lower);
    }
    if (lower === "true" || lower === "false") {
      return { type: "boolean", value: lower === "true" };
    }
    if (lower === "null") {
      return { type: "null" };
    }
    return { type: "identifier", name: lower };
  };
  const parsePostfix = (): Expression => {
    let target = parsePrimary();
    while (parsing()) {
      if (peek() === ".") {
        take(".");
        const name = take();
        if (name !== "*" && !IDENTIFIER.test(name)) {
          failed = true;
          return INVALID;
        }
        target = { type: "member", target, name: name.toLowerCase() };
      } else if (peek() === "[") {
        take("[");
        const index = parseOr();
        take("]");
        target = { type: "index", target, index };
      } else {
        break;
      }
    }
    return target;
  };
  const parseUnary = (): Expression => {
    if (peek() === "!") {
      take("!");
      return { type: "not", operand: parseUnary() };
    }
    return parsePostfix();
  };
  const parseRelational = binaryLevel(["<", "<=", ">", ">="], parseUnary);
  const parseEquality = binaryLevel(["==", "!="], parseRelational);
  const parseAnd = binaryLevel(["&&"], parseEquality);
  const parseOr: () => Expression = binaryLevel(["||"], parseAnd);
  const expression = parseOr();
  return parsing() && cursor === tokens.length ? expression : undefined;
};

// A canonical spelling: two expressions match only when their parse trees do.
const renderExpression = (expression: Expression): string => {
  switch (expression.type) {
    case "boolean":
      return String(expression.value);
    case "string":
      return `'${expression.value.replaceAll("'", "''")}'`;
    case "number":
      return expression.value;
    case "null":
      return "null";
    case "identifier":
      return expression.name;
    case "member":
      return `${renderExpression(expression.target)}.${expression.name}`;
    case "index":
      return `${renderExpression(expression.target)}[${renderExpression(expression.index)}]`;
    case "call":
      return `${expression.name}(${expression.args.map(renderExpression).join(", ")})`;
    case "not":
      return `!(${renderExpression(expression.operand)})`;
    default:
      // Every other kind is handled above, so this is the binary operator.
      return `(${renderExpression(expression.left)} ${expression.operator} ${renderExpression(expression.right)})`;
  }
};

// The expression an `if` value evaluates: a bare expression, or exactly one
// `${{ … }}` with nothing around it. Anything else has no single reading.
const conditionExpression = (source: string): Expression | undefined => {
  if (!source.includes("${{")) {
    return parseExpression(source);
  }
  const body = soleExpressionBody(source);
  return body === undefined ? undefined : parseExpression(body);
};

type Truth = "false" | "true" | "unknown";
type ConditionContext = {
  actor?: string;
  eventName?: string;
};
type Literal =
  { kind: "boolean"; value: boolean } | { kind: "string"; value: string };

const negate = (value: Truth): Truth => {
  if (value === "true") {
    return "false";
  }
  if (value === "false") {
    return "true";
  }
  return "unknown";
};

const dottedName = (expression: Expression): string | undefined => {
  if (expression.type === "identifier") {
    return expression.name;
  }
  if (expression.type === "member") {
    const target = dottedName(expression.target);
    return target === undefined ? undefined : `${target}.${expression.name}`;
  }
  return undefined;
};

const literalOf = (
  expression: Expression,
  context: ConditionContext,
): Literal | undefined => {
  if (expression.type === "boolean") {
    return { kind: "boolean", value: expression.value };
  }
  if (expression.type === "string") {
    return { kind: "string", value: expression.value };
  }
  const values: Record<string, string | undefined> = {
    "github.event_name": context.eventName,
    "github.actor": context.actor,
  };
  const name = dottedName(expression);
  const value = name === undefined ? undefined : values[name];
  return value === undefined ? undefined : { kind: "string", value };
};

// Only comparisons whose result is certain are decided: Actions coerces
// mismatched kinds to numbers, so those stay unknown.
const truthOf = (expression: Expression, context: ConditionContext): Truth => {
  if (expression.type === "boolean") {
    return expression.value ? "true" : "false";
  }
  if (expression.type === "string") {
    return expression.value === "" ? "false" : "true";
  }
  if (expression.type === "not") {
    return negate(truthOf(expression.operand, context));
  }
  if (expression.type !== "binary") {
    return "unknown";
  }
  if (expression.operator === "&&" || expression.operator === "||") {
    const left = truthOf(expression.left, context);
    const right = truthOf(expression.right, context);
    const dominant = expression.operator === "&&" ? "false" : "true";
    if (left === dominant || right === dominant) {
      return dominant;
    }
    return left === "unknown" || right === "unknown" ? "unknown" : left;
  }
  if (expression.operator !== "==" && expression.operator !== "!=") {
    return "unknown";
  }
  const left = literalOf(expression.left, context);
  const right = literalOf(expression.right, context);
  if (left === undefined || right === undefined || left.kind !== right.kind) {
    return "unknown";
  }
  // Actions compares strings case-insensitively.
  const equal =
    left.kind === "string" && right.kind === "string"
      ? left.value.toLowerCase() === right.value.toLowerCase()
      : left.value === right.value;
  return (expression.operator === "==") === equal ? "true" : "false";
};

// One evaluator for job and step conditions. YAML reads a bare `if: false`
// as a boolean, not as expression text.
const conditionTruth = (raw: unknown, context: ConditionContext): Truth => {
  if (raw === undefined || raw === null) {
    return "true";
  }
  if (typeof raw === "boolean") {
    return raw ? "true" : "false";
  }
  if (typeof raw !== "string") {
    return "unknown";
  }
  const expression = conditionExpression(raw);
  return expression === undefined ? "unknown" : truthOf(expression, context);
};

const excludesEvent = (condition: unknown, eventName: string): boolean =>
  conditionTruth(condition, { eventName }) === "false";
const excludesActor = (condition: unknown, actor: string): boolean =>
  conditionTruth(condition, { actor }) === "false";

const TRUE: Expression = { type: "boolean", value: true };
const FALSE: Expression = { type: "boolean", value: false };

// Folds every subexpression whose truth the context decides, so a guard
// that is only one side of a disjunction (`trusted || event == 'x'`) is
// still found when the context rules the other side out.
const simplify = (
  expression: Expression,
  context: ConditionContext,
): Expression => {
  if (expression.type === "not") {
    const operand = simplify(expression.operand, context);
    if (operand.type === "boolean") {
      return operand.value ? FALSE : TRUE;
    }
    return { type: "not", operand };
  }
  if (
    expression.type === "binary" &&
    (expression.operator === "&&" || expression.operator === "||")
  ) {
    const left = simplify(expression.left, context);
    const right = simplify(expression.right, context);
    const dominant = expression.operator === "||";
    if (
      (left.type === "boolean" && left.value === dominant) ||
      (right.type === "boolean" && right.value === dominant)
    ) {
      return dominant ? TRUE : FALSE;
    }
    if (left.type === "boolean") {
      return right;
    }
    if (right.type === "boolean") {
      return left;
    }
    return { ...expression, left, right };
  }
  if (expression.type === "binary") {
    const truth = truthOf(expression, context);
    if (truth !== "unknown") {
      return truth === "true" ? TRUE : FALSE;
    }
  }
  return expression;
};

const conjunctsOf = (expression: Expression): Expression[] =>
  expression.type === "binary" && expression.operator === "&&"
    ? [...conjunctsOf(expression.left), ...conjunctsOf(expression.right)]
    : [expression];

const renderedCondition = (source: string): string | undefined => {
  const expression = parseExpression(source);
  return expression === undefined ? undefined : renderExpression(expression);
};

/** Parses a condition fragment as the exemption check reads it. */
export const parsesAsCondition = (fragment: string): boolean =>
  renderedCondition(fragment) !== undefined;

// ---------------------------------------------------------------------------
// Triggers

// Events whose runs never carry pull-request content into the workflow.
const SAFE_TRIGGERS = new Set([
  "create",
  "delete",
  "merge_group",
  "push",
  "release",
  "schedule",
  "workflow_call",
  "workflow_dispatch",
]);
// Events that run the pull request's own workflow revision.
const PULL_REQUEST_TRIGGERS = new Set([
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
]);
// Privileged events whose default revision is a base-branch commit. Any
// other analysed event (deployment_status runs on the deployed commit) is
// privileged with an untrusted default revision.
const BASE_REVISION_TRIGGERS = new Set([
  "check_run",
  "check_suite",
  "issue_comment",
  "pull_request_target",
  "workflow_run",
]);
const isPullRequestTrigger = (trigger: string): boolean =>
  PULL_REQUEST_TRIGGERS.has(trigger);
const runsFromBase = (trigger: string): boolean =>
  BASE_REVISION_TRIGGERS.has(trigger);
// Privileged events default the workflow token to write access.
const isPrivilegedTrigger = (trigger: string): boolean =>
  !isPullRequestTrigger(trigger);

const triggersOf = (on: unknown): string[] => {
  if (typeof on === "string") {
    return [on];
  }
  if (Array.isArray(on)) {
    return on.filter((item) => typeof item === "string");
  }
  return record(on) ? Object.keys(on) : [];
};

// ---------------------------------------------------------------------------
// Privileges

const SECRETS_CONTEXT = /(?<![A-Za-z0-9_.-])secrets(?![A-Za-z0-9_-])/giu;
// Actions skips whitespace between tokens and matches names
// case-insensitively; a computed key or the whole context is `*`.
const SECRET_NAME =
  /^\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_-]*)|\[\s*'((?:[^']|'')*)'\s*\])/u;
const WORKFLOW_TOKEN = "GITHUB_TOKEN";
const ANY_SECRET = "*";
const INHERITED_SECRETS = "inherit";

// Every repository secret a value references; the workflow token itself is
// not a repository secret.
const secretNamesOf = (value: unknown): Set<string> => {
  const names = new Set<string>();
  for (const item of stringsOf(value)) {
    for (const body of expressionBodies(item)) {
      for (const match of body.matchAll(SECRETS_CONTEXT)) {
        const access = SECRET_NAME.exec(
          body.slice(match.index + match[0].length),
        );
        const raw = access?.[1] ?? access?.[2]?.replaceAll("''", "'");
        const name = raw === undefined ? ANY_SECRET : raw.toUpperCase();
        if (name !== WORKFLOW_TOKEN) {
          names.add(name);
        }
      }
    }
  }
  return names;
};

const ALL_SCOPES = "*";
const writeScopesOf = (
  permissions: unknown,
  defaultIsWrite: boolean,
): Set<string> => {
  if (permissions === undefined) {
    return new Set(defaultIsWrite ? [ALL_SCOPES] : []);
  }
  if (permissions === "read-all") {
    return new Set();
  }
  if (!record(permissions)) {
    return new Set([ALL_SCOPES]);
  }
  return new Set(
    Object.entries(permissions)
      .filter(([, access]) => String(access).toLowerCase() === "write")
      .map(([scope]) => scope.toLowerCase()),
  );
};

// ---------------------------------------------------------------------------
// Checkouts

// `${{ <expression> }}` wrappers are stripped by string operations: the
// equivalent regular expressions backtrack super-linearly on long input.
const stripExpressionWrapper = (wrapped: string): string => {
  let expression = wrapped.trim();
  if (expression.startsWith("${{")) {
    expression = expression.slice(3).trimStart();
  }
  if (expression.endsWith("}}")) {
    expression = expression.slice(0, -2).trimEnd();
  }
  return expression;
};

const checkoutExpressionOf = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("${{") || !trimmed.endsWith("}}")) {
    return undefined;
  }
  const expression = stripExpressionWrapper(trimmed);
  return expression === "" || /[{}]/u.test(expression) ? undefined : expression;
};

// The comparison-base output is trusted only when the step that produces it is
// the repository's resolver, not merely a step with the same id.
const TARGET_BASE_STEP_ID = "target-base";
const TARGET_BASE_ACTION = "./.github/actions/merge-target-base";
const TARGET_BASE_RUN = 'bash "$RUNNER_TEMP/merge-target-base.sh"';

const TARGET_BASE_SCRIPT = "merge-target-base.sh";
const stagedResolverSource = (command: string): string | undefined => {
  const prefix = 'cp "$GITHUB_WORKSPACE/';
  const suffix = `/scripts/${TARGET_BASE_SCRIPT}" "$RUNNER_TEMP/${TARGET_BASE_SCRIPT}"`;
  const trimmed = command.trim();
  return trimmed.startsWith(prefix) && trimmed.endsWith(suffix)
    ? trimmed.slice(prefix.length, -suffix.length)
    : undefined;
};

type TrustedTargetBaseOptions = {
  steps: readonly unknown[];
  trigger: string;
  controlledDirectories: ReadonlyMap<string, ReadonlySet<string>>;
};

// The run form is trusted only when the script it runs was staged by exactly
// one earlier step, copied from a checkout this trigger does not control.
const trustedTargetBase = ({
  steps,
  trigger,
  controlledDirectories,
}: TrustedTargetBaseOptions): boolean => {
  const index = steps.findIndex(
    (step) => record(step) && step["id"] === TARGET_BASE_STEP_ID,
  );
  const resolver = steps[index];
  if (!record(resolver)) {
    return false;
  }
  if (resolver["uses"] === TARGET_BASE_ACTION) {
    return true;
  }
  if (
    typeof resolver["run"] !== "string" ||
    resolver["run"].trim() !== TARGET_BASE_RUN
  ) {
    return false;
  }
  const writers = steps
    .slice(0, index)
    .filter(
      (step): step is Record<string, unknown> =>
        record(step) &&
        typeof step["run"] === "string" &&
        step["run"].includes(TARGET_BASE_SCRIPT),
    );
  const [writer] = writers;
  if (writers.length !== 1 || writer === undefined) {
    return false;
  }
  const source =
    typeof writer["run"] === "string"
      ? stagedResolverSource(writer["run"])
      : undefined;
  const controlled =
    source === undefined ? undefined : controlledDirectories.get(source);
  return controlled !== undefined && !controlled.has(trigger);
};

type TrustedCheckoutValueOptions = TrustedTargetBaseOptions & {
  value: unknown;
  field: "ref" | "repository";
};

const PULL_REQUEST_REF = /refs\/pull\/|^pull\//iu;

const trustedCheckoutValue = ({
  value,
  trigger,
  field,
  steps,
  controlledDirectories,
}: TrustedCheckoutValueOptions): boolean => {
  // actions/checkout treats an empty input like an omitted one.
  if (value === undefined || value === "") {
    return field === "repository" || runsFromBase(trigger);
  }
  if (typeof value !== "string") {
    return false;
  }
  const checkoutExpression = checkoutExpressionOf(value);
  if (checkoutExpression === undefined) {
    // A literal is trusted unless it names a pull-request ref; an expression
    // interpolated into a longer value (`refs/heads/${{ ... }}`) is not an
    // approved form.
    return !value.includes("${{") && !PULL_REQUEST_REF.test(value);
  }
  // The workflow revision and github.sha are base-branch commits only for
  // events whose workflow runs from the base branch.
  if (
    checkoutExpression === "github.workflow_sha" ||
    checkoutExpression === "github.sha"
  ) {
    return runsFromBase(trigger);
  }
  if (field === "repository" && checkoutExpression === "github.repository") {
    return true;
  }
  return (
    checkoutExpression === `steps.${TARGET_BASE_STEP_ID}.outputs.base_sha` &&
    trustedTargetBase({ steps, trigger, controlledDirectories })
  );
};

const isExpression = (value: unknown): boolean =>
  typeof value === "string" && value.includes("${{");

// A literal directory relative to the workspace root; every spelling of the
// root (omitted, empty, `.`, `./`, `a/..`) is `.`. `undefined` means the
// location is unknown: an expression, a variable, an absolute or home path,
// or one that leaves the workspace.
const workspaceDirectory = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return ".";
  }
  if (
    typeof value !== "string" ||
    isExpression(value) ||
    /[$\\]/u.test(value) ||
    value.startsWith("~") ||
    path.posix.isAbsolute(value)
  ) {
    return undefined;
  }
  // normalize collapses repeated separators, so one trailing slash remains
  // at most; string operations avoid a backtracking pattern.
  const collapsed = path.posix.normalize(value);
  const normalized = collapsed.endsWith("/")
    ? collapsed.slice(0, -1)
    : collapsed;
  if (normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized === "" ? "." : normalized;
};

// A checkout whose location is unknown counts as the root, whose checks
// match every step.
const checkoutDirectory = (value: unknown): string =>
  workspaceDirectory(value) ?? ".";

// ---------------------------------------------------------------------------
// Steps

// Remote actions reviewed to only store or restore files, never to run what
// they find in the workspace.
const READ_ONLY_ACTIONS = new Set([
  "actions/cache",
  "actions/cache/restore",
  "actions/cache/save",
  "actions/download-artifact",
  "actions/upload-artifact",
]);
const actionNameOf = (uses: string): string =>
  uses.toLowerCase().split("@")[0] ?? "";
const isCheckoutAction = (uses: string): boolean =>
  actionNameOf(uses) === "actions/checkout";

// Commands that bring another revision into the workspace. The GitHub CLI
// subcommands match without the `gh` prefix, so a wrapper script counts too.
const REVISION_FETCH =
  /\bgit\b[^\n;&|]*?\b(?:am|apply|checkout|cherry-pick|clone|fetch|merge|pull|rebase|reset|restore|switch|worktree)\b|\b(?:pr\s+checkout|repo\s+clone|run\s+download)\b|refs\/pull\b/iu;
// A value computed at run time may name any directory.
const RUNTIME_VALUE = /\$\{\{|\$[A-Za-z_{(]/u;
// An action input that is only a credential names no directory.
const CREDENTIAL_EXPRESSION =
  /^\s*(?:secrets\s*\.\s*[A-Za-z_][A-Za-z0-9_-]*|github\s*\.\s*token)\s*$/iu;

type InheritedStepSettings = {
  // `defaults.run` of the job, else of the workflow.
  workingDirectory: unknown;
  shell: unknown;
  // `env` of the job and of the workflow.
  env: readonly unknown[];
};

type StepReachesOptions = {
  step: Record<string, unknown>;
  directory: string;
  inherited: InheritedStepSettings;
};

// A path naming the directory or any directory above it reaches it,
// including `cd parent && ...` and workspace-qualified spellings.
const mentionsDirectory = (directory: string, values: readonly string[]) => {
  const segments = directory.split("/");
  const patterns = segments.map((_, index) => {
    const prefix = segments
      .slice(0, index + 1)
      .join("/")
      .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(
      `(?:^|[\\s'"=/:(,{[\`])\\.?/?${prefix}(?:/|$|[\\s'";&|)\\]},:\`])`,
      "u",
    );
  });
  return values.some((value) =>
    patterns.some((pattern) => pattern.test(value)),
  );
};

const stepReaches = ({
  step,
  directory,
  inherited,
}: StepReachesOptions): boolean => {
  const command = stringField(step["run"]);
  const uses = stringField(step["uses"]);
  const runs = command !== "";
  const local = uses.startsWith("./");
  const remote = uses !== "" && !local && !isCheckoutAction(uses);
  if (directory === ".") {
    // A root checkout is the default directory of every command and action.
    return (
      runs || local || (remote && !READ_ONLY_ACTIONS.has(actionNameOf(uses)))
    );
  }
  if (!runs && !local && !remote) {
    return false;
  }
  const env = [step["env"], ...inherited.env].flatMap(stringsOf);
  // Every action reads the paths its inputs name (a build context, a
  // Dockerfile) and may run what it finds there; a checkout only writes one.
  const inputs = runs ? [] : stringsOf(step["with"]);
  if (
    inputs.some((input) =>
      expressionBodies(input).some((body) => !CREDENTIAL_EXPRESSION.test(body)),
    )
  ) {
    return true;
  }
  if (runs) {
    const shell = stringField(step["shell"] ?? inherited.shell);
    const workingDirectory = workspaceDirectory(
      step["working-directory"] ?? inherited.workingDirectory,
    );
    if (
      workingDirectory === undefined ||
      workingDirectory === directory ||
      workingDirectory.startsWith(`${directory}/`) ||
      (workingDirectory !== "." && directory.startsWith(`${workingDirectory}/`))
    ) {
      return true;
    }
    if (RUNTIME_VALUE.test(command) || RUNTIME_VALUE.test(shell)) {
      return true;
    }
    return mentionsDirectory(directory, [command, shell, ...env]);
  }
  return mentionsDirectory(directory, [uses, ...inputs, ...env]);
};

const runDefault = (
  owner: Record<string, unknown>,
  field: "shell" | "working-directory",
): unknown => {
  const defaults = owner["defaults"];
  const run = record(defaults) ? defaults["run"] : undefined;
  return record(run) ? run[field] : undefined;
};

const stepsOf = (job: Record<string, unknown>): unknown[] =>
  Array.isArray(job["steps"]) ? job["steps"] : [];

type StepFindingOptions = {
  excludesDependabot: boolean;
  file: string;
  job: string;
  permissions: unknown;
  triggers: readonly string[];
  rawJob: Record<string, unknown>;
  secret: boolean;
  step: string;
};

const findingsForStep = (options: StepFindingOptions): Finding[] => {
  const findings: Finding[] = [];
  const write = writeScopesOf(options.permissions, false).size > 0;
  for (const trigger of options.triggers) {
    const classes: Finding["class"][] = [];
    const pullRequest = isPullRequestTrigger(trigger);
    if (
      isPrivilegedTrigger(trigger) &&
      (writeScopesOf(options.permissions, true).size > 0 || options.secret)
    ) {
      classes.push("class 1");
    }
    if (
      pullRequest &&
      (options.secret || /create-github-app-token/iu.test(text(options.rawJob)))
    ) {
      classes.push("class 2");
    }
    if (
      pullRequest &&
      !options.excludesDependabot &&
      (options.secret || write)
    ) {
      classes.push("class 3");
    }
    for (const violation of classes) {
      findings.push({
        file: options.file,
        job: options.job,
        step: options.step,
        class: violation,
        trigger,
      });
    }
  }
  return findings;
};

// ---------------------------------------------------------------------------
// Jobs

type JobAnalysis = {
  key: string;
  condition: unknown;
  calls: string;
  privileges: { write: ReadonlySet<string>; secrets: ReadonlySet<string> };
  findings: readonly Finding[];
};

const analyseJob = (
  file: string,
  workflow: Record<string, unknown>,
  triggers: readonly string[],
  [jobName, rawJob]: [string, Record<string, unknown>],
): JobAnalysis => {
  const findings: Finding[] = [];
  const permissions = rawJob["permissions"] ?? workflow["permissions"];
  const steps = stepsOf(rawJob);
  const secrets = new Set([
    ...secretNamesOf(workflow["env"]),
    ...secretNamesOf(workflow["defaults"]),
    ...secretNamesOf(rawJob),
    ...(rawJob["secrets"] === INHERITED_SECRETS ? [INHERITED_SECRETS] : []),
  ]);
  const secret = secrets.size > 0;
  const condition = rawJob["if"];
  const reachingTriggers = triggers.filter(
    (trigger) => !excludesEvent(condition, trigger),
  );
  const finding = (step: string, stepTriggers: readonly string[]) =>
    findingsForStep({
      excludesDependabot: excludesActor(condition, "dependabot[bot]"),
      file,
      job: jobName,
      permissions,
      triggers: stepTriggers,
      rawJob,
      secret,
      step,
    });
  const controlledDirectories = new Map<string, Set<string>>();
  const control = (directory: string, controlled: readonly string[]) => {
    // A later step may be skipped by its own condition, so it never clears
    // triggers an earlier step already made untrusted.
    controlledDirectories.set(
      directory,
      new Set([...(controlledDirectories.get(directory) ?? []), ...controlled]),
    );
  };
  const inherited: InheritedStepSettings = {
    workingDirectory:
      runDefault(rawJob, "working-directory") ??
      runDefault(workflow, "working-directory"),
    shell: runDefault(rawJob, "shell") ?? runDefault(workflow, "shell"),
    env: [rawJob["env"], workflow["env"]],
  };
  for (const rawStep of steps) {
    if (!record(rawStep)) {
      continue;
    }
    const uses = stringField(rawStep["uses"]);
    const withValue = record(rawStep["with"]) ? rawStep["with"] : {};
    if (isCheckoutAction(uses)) {
      control(
        checkoutDirectory(withValue["path"]),
        triggers.filter(
          (trigger) =>
            !trustedCheckoutValue({
              value: withValue["ref"],
              trigger,
              field: "ref",
              steps,
              controlledDirectories,
            }) ||
            !trustedCheckoutValue({
              value: withValue["repository"],
              trigger,
              field: "repository",
              steps,
              controlledDirectories,
            }),
        ),
      );
    }
    if (REVISION_FETCH.test(stringField(rawStep["run"]))) {
      control(".", triggers);
    }
    const artifact =
      actionNameOf(uses) === "actions/download-artifact" &&
      (withValue["run-id"] !== undefined ||
        withValue["github-token"] !== undefined);
    const controlledTriggers = artifact
      ? reachingTriggers
      : reachingTriggers.filter((trigger) =>
          [...controlledDirectories].some(
            ([directory, controlled]) =>
              controlled.has(trigger) &&
              stepReaches({ step: rawStep, directory, inherited }),
          ),
        );
    const reachableTriggers = controlledTriggers.filter(
      (trigger) => !excludesEvent(rawStep["if"], trigger),
    );
    if (reachableTriggers.length > 0) {
      findings.push(
        ...finding(
          typeof rawStep["name"] === "string"
            ? rawStep["name"]
            : "unnamed step",
          reachableTriggers,
        ),
      );
    }
  }
  // A called workflow receives the job's privileges and the event, and may
  // check out and run whatever the event names.
  const reusableUses = stringField(rawJob["uses"]);
  if (reusableUses !== "") {
    findings.push(...finding(reusableUses, reachingTriggers));
  }
  return {
    key: `${file}:${jobName}`,
    condition,
    calls: reusableUses,
    privileges: {
      write: writeScopesOf(permissions, triggers.some(isPrivilegedTrigger)),
      secrets,
    },
    findings,
  };
};

const analyseWorkflow = (file: string, source: string): JobAnalysis[] => {
  const parsed: unknown = Bun.YAML.parse(source);
  if (!record(parsed)) {
    throw new WorkflowPrivilegePolicyError({
      message: "workflow must be a mapping",
      file,
    });
  }
  const triggers = triggersOf(parsed["on"]).filter(
    (trigger) => !SAFE_TRIGGERS.has(trigger),
  );
  if (triggers.length === 0 || !record(parsed["jobs"])) {
    return [];
  }
  return Object.entries(parsed["jobs"])
    .filter((entry): entry is [string, Record<string, unknown>] =>
      record(entry[1]),
    )
    .map((entry) => analyseJob(file, parsed, triggers, entry));
};

// ---------------------------------------------------------------------------
// Exemptions

const WORKFLOW_PRIVILEGE_EXEMPTIONS: ReadonlyMap<
  string,
  WorkflowPrivilegeExemption
> = new Map(Object.entries(WORKFLOW_PRIVILEGE_ALLOWLIST));

// An entry whose job ends in `*` covers the jobs of that workflow with the
// prefix that call exactly its pinned workflow; each is still bound to the
// entry's condition and privileges. An exact entry wins over a pattern.
const exemptionKeyFor = (job: JobAnalysis): string | undefined => {
  if (WORKFLOW_PRIVILEGE_EXEMPTIONS.has(job.key)) {
    return job.key;
  }
  const patterns = [...WORKFLOW_PRIVILEGE_EXEMPTIONS].filter(
    ([entry, exemption]) =>
      entry.endsWith("*") &&
      job.key.startsWith(entry.slice(0, -1)) &&
      exemption.calls !== undefined &&
      exemption.calls === job.calls,
  );
  const [pattern] = patterns;
  return patterns.length === 1 && pattern !== undefined
    ? pattern[0]
    : undefined;
};

const conditionHolds = (
  requires: ExemptionCondition,
  condition: unknown,
  eventName: string,
): boolean => {
  if ("unconditional" in requires) {
    return true;
  }
  const expression =
    typeof condition === "string" ? conditionExpression(condition) : undefined;
  if (expression === undefined) {
    return false;
  }
  // Only a top-level conjunct constrains the whole condition: nothing above
  // it may be a disjunction or a negation once the event is known.
  const conjuncts = new Set(
    conjunctsOf(simplify(expression, { eventName })).map(renderExpression),
  );
  return requires.conjuncts.every((fragment) => {
    const rendered = renderedCondition(fragment);
    return rendered !== undefined && conjuncts.has(rendered);
  });
};

const privilegesBeyond = (
  approved: ExemptionPrivileges,
  privileges: JobAnalysis["privileges"],
): string[] => [
  ...[...privileges.write]
    .filter((scope) => !approved.write.includes(scope))
    .map((scope) => `${scope}: write`),
  ...[...privileges.secrets]
    .filter((name) => !approved.secrets.includes(name))
    .map((name) => `secrets.${name}`),
];

// An exemption covers only the findings it was approved for, only while the
// job keeps the condition its reason depends on, and only for the privileges
// it was approved with; anything else is reported.
const unexemptedFindings = (job: JobAnalysis): readonly Finding[] => {
  const exemptionKey = exemptionKeyFor(job);
  const exemption =
    exemptionKey === undefined
      ? undefined
      : WORKFLOW_PRIVILEGE_EXEMPTIONS.get(exemptionKey);
  if (exemption === undefined) {
    return job.findings;
  }
  // A remote called workflow is approved only at the exact pinned revision.
  const callLapses =
    (exemption.calls !== undefined ||
      (job.calls !== "" && !job.calls.startsWith("./"))) &&
    exemption.calls !== job.calls
      ? ["the called workflow is not the approved revision"]
      : [];
  const beyond = [
    ...callLapses,
    ...privilegesBeyond(exemption.privileges, job.privileges).map(
      (privilege) => `${privilege} is beyond the exemption`,
    ),
  ];
  return job.findings.flatMap((finding) => {
    const lapses = [
      ...(conditionHolds(exemption.requires, job.condition, finding.trigger)
        ? []
        : ["the job condition no longer requires what the exemption needs"]),
      ...beyond,
    ];
    if (lapses.length > 0) {
      return [{ ...finding, step: `${finding.step} (${lapses.join("; ")})` }];
    }
    return exemption.covers.includes(`${finding.class}:${finding.trigger}`)
      ? []
      : [finding];
  });
};

export const checkWorkflowPrivilegeSource = (
  file: string,
  source: string,
): Finding[] => analyseWorkflow(file, source).flatMap(unexemptedFindings);

const workflowFiles = (root: string): string[] =>
  readdirSync(path.join(root, ".github/workflows"))
    .filter((file) => /\.ya?ml$/u.test(file))
    .map((file) => `.github/workflows/${file}`);

/**
 * Allowlist findings no job produces any more, and approved privileges a job
 * no longer holds, so every entry stays as narrow as the job it covers.
 */
export const unusedWorkflowPrivilegeExemptions = (
  root = process.cwd(),
): string[] => {
  const jobs = workflowFiles(root).flatMap((file) =>
    analyseWorkflow(file, readFileSync(path.join(root, file), "utf-8")),
  );
  return [...WORKFLOW_PRIVILEGE_EXEMPTIONS].flatMap(([key, exemption]) => {
    const covered = jobs.filter((job) => exemptionKeyFor(job) === key);
    if (covered.length === 0) {
      return [`${key}: no job`];
    }
    // Every covered job must produce each approved finding and hold each
    // approved privilege, so a pattern stays as narrow as its least
    // privileged job.
    return covered.flatMap((job) => {
      const produced = new Set(
        job.findings.map((finding) => `${finding.class}:${finding.trigger}`),
      );
      return [
        ...exemption.covers.filter((finding) => !produced.has(finding)),
        ...exemption.privileges.write
          .filter((scope) => !job.privileges.write.has(scope))
          .map((scope) => `${scope}: write`),
        ...exemption.privileges.secrets
          .filter((name) => !job.privileges.secrets.has(name))
          .map((name) => `secrets.${name}`),
      ].map((unused) => `${job.key}: ${unused}`);
    });
  });
};

export const checkWorkflowPrivileges = (root = process.cwd()): Finding[] =>
  workflowFiles(root)
    .flatMap((file) =>
      checkWorkflowPrivilegeSource(
        file,
        readFileSync(path.join(root, file), "utf-8"),
      ),
    )
    .toSorted((a, b) => {
      const left = `${a.file}:${a.job}:${a.step}`;
      const right = `${b.file}:${b.job}:${b.step}`;
      if (left < right) {
        return -1;
      }
      return left > right ? 1 : 0;
    });

if (import.meta.main) {
  const findings = checkWorkflowPrivileges();
  for (const finding of findings) {
    process.stderr.write(
      `${finding.file}: job ${finding.job}, ${finding.step}: ${finding.class} (${finding.trigger})\n`,
    );
  }
  if (findings.length > 0) {
    process.exit(1);
  }
}
