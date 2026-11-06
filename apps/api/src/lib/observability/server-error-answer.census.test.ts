/**
 * A 5xx answer is built only from its cause. `server-error-answer.ts` owns
 * the answers handlers and stages build themselves (`observedStatus`,
 * `observedResponse`) and observes the cause on the request in flight before
 * it answers; the safe handler boundary (`api-handlers.ts`) and the error
 * boundary (`request-lifecycle.ts`) answer the failures they log.
 *
 * This scan finds the status of every answer construction: the code passed to
 * `status()` or `new HttpStatusResponse()`, the `status` of a `Response`, of
 * `Response.json()` or of a `*Response()` helper's options, and what a caller
 * passes to a same-file helper that hands its parameter on as that status. A
 * literal 5xx there fails anywhere. A computed status fails outside the owners
 * unless it is listed below with the reason it never answers an unobserved 5xx.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  type CallExpression,
  type NewExpression,
  type Node,
  parseSource,
  walk,
} from "@stll/scripts/src/syntax-tree";

const API_ROOT = path.resolve(import.meta.dir, "../../..");
const OWNER = "src/lib/observability/server-error-answer.ts";
const OWNER_API = `observedStatus or observedResponse from ${OWNER}`;
const OWNER_CONSTRUCTORS: ReadonlySet<string> = new Set([
  "observedStatus",
  "observedResponse",
]);

/** Modules that answer a status another stage chose, or log what they answer. */
const OWNERS: ReadonlySet<string> = new Set([
  OWNER,
  // The status primitive and the HTTP layer that encodes a handler's answer.
  "src/http/status.ts",
  "src/http/respond.ts",
  "src/http/app.ts",
  // The safe handler boundary logs every failure before it answers it.
  "src/lib/api-handlers.ts",
  // The error boundary logs every failure the pipeline throws.
  "src/lib/observability/request-lifecycle.ts",
]);

/**
 * A literal 5xx waiting on an open change, by file. Each names the change; an
 * entry whose file no longer builds one fails, so it leaves with the site.
 */
const PENDING_LITERAL: Readonly<Record<string, string>> = {
  "src/mcp/server-core.ts":
    "PR 6907 observes the cause at the one caller of retryableServerErrorResponse (observeTransportFailure); the 503 moves behind observedResponse once it lands",
};

/**
 * Computed statuses outside the owners, by file and status expression. Each
 * says why the answer is never an unobserved 5xx; an entry that no longer
 * matches a site fails.
 */
const COMPUTED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "src/handlers/auth/metadata.ts": {
    "response.status":
      "re-wraps the Better Auth answer, whose failures its own hooks observe",
    "upstream.status":
      "re-wraps the Better Auth answer, whose failures its own hooks observe",
  },
  "src/handlers/case-law/ingestion/eu-completion-runner.ts": {
    "response.status":
      "re-wraps an upstream answer the runner reads, never served",
  },
  "src/handlers/chat/stream-chat.ts": {
    "error.status":
      "ChatTurnFailureResponse observes a 500's cause in its constructor (observeServerError)",
  },
  "src/lib/auth.ts": {
    "result.statusCode":
      "a 401 or 403 rejection; the 500 is answered by authUnavailableAnswer",
  },
  "src/lib/legal-search/public-law-country.ts": {
    PUBLIC_COUNTRY_UNAVAILABLE_STATUS:
      "the contract's country refusal, a 404 (PUBLIC_COUNTRY_UNAVAILABLE_STATUS)",
  },
  "src/lib/idempotency/request-receipts.ts": {
    "claim.status":
      "replays a stored receipt; only 2xx answers are completed as receipts",
  },
  "src/lib/mcp-upstream/connections.ts": {
    "response.value.status":
      "re-wraps a connector's upstream answer the caller reads, never served",
  },
  "src/lib/rate-limit/action-size-limits.ts": {
    "refused.status": "copies the refusal actionSizeErrorResponse built",
    "response.status": "re-frames the inner answer after metering it",
  },
  "src/lib/sse.ts": {
    "response.status": "re-wraps the stream answer with its heartbeat",
  },
  "src/mcp/json-rpc-error-response.ts": {
    status: "the envelope helper; its callers pass the status and are scanned",
  },
  "src/mcp/server-core.ts": {
    "response.status": "re-wraps the transport's answer with CORS headers",
    status: "an access denial, 401 or 403 (MCP_ACCESS_DENIALS)",
  },
};

type StatusSite = {
  readonly kind: "literal" | "computed";
  readonly expression: string;
  readonly line: number;
};

const SERVER_ERROR_LITERAL = /^5\d\d$/u;

const isServerErrorLiteral = (node: Node): boolean =>
  node.type === "Literal" &&
  typeof node.value === "number" &&
  SERVER_ERROR_LITERAL.test(String(node.value));

const containsServerErrorLiteral = (node: Node): boolean => {
  let found = false;
  walk(node, (child) => {
    if (found) {
      return "skip-children";
    }
    found = isServerErrorLiteral(child);
    return undefined;
  });
  return found;
};

const calleeName = (expression: Node): string | undefined => {
  if (expression.type === "Identifier") {
    return expression.name;
  }
  if (
    expression.type === "MemberExpression" &&
    !expression.computed &&
    expression.property.type === "Identifier"
  ) {
    return expression.property.name;
  }
  return undefined;
};

const statusProperty = (node: Node): Node | undefined => {
  if (node.type !== "ObjectExpression") {
    return undefined;
  }
  for (const property of node.properties) {
    if (
      property.type === "Property" &&
      property.kind === "init" &&
      !property.method &&
      !property.computed &&
      property.key.type === "Identifier" &&
      property.key.name === "status"
    ) {
      return property.value;
    }
  }
  return undefined;
};

type Constructed = {
  readonly expression: Node;
  readonly init: boolean;
};

type Construction = CallExpression | NewExpression;

/**
 * The status expressions a call or construction builds an answer with; an
 * `init` one is a whole `ResponseInit`.
 */
const constructedStatuses = (
  node: Construction,
  source: string,
): Constructed[] => {
  const name = calleeName(node.callee);
  const args = node.arguments;
  const [first, second] = args;
  if (
    first !== undefined &&
    ((node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      name === "status") ||
      (node.type === "NewExpression" && name === "HttpStatusResponse"))
  ) {
    return [{ expression: first, init: false }];
  }
  if (
    name === "Response" ||
    (name === "json" &&
      source.slice(node.callee.start, node.callee.end) === "Response.json")
  ) {
    return second === undefined ? [] : [{ expression: second, init: true }];
  }
  // The owner's own constructors take the status beside the cause.
  if (
    name !== undefined &&
    name.endsWith("Response") &&
    !OWNER_CONSTRUCTORS.has(name)
  ) {
    return args.flatMap((arg) => {
      const status = statusProperty(arg);
      return status === undefined ? [] : [{ expression: status, init: false }];
    });
  }
  return [];
};

type Helper = { readonly name: string; readonly exported: boolean };

const FUNCTION_LIKE: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
  "TSConstructorType",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
  "TSFunctionType",
  "TSMethodSignature",
]);

/** The identifier a parameter binds, through a default, rest or modifier. */
const parameterName = (parameter: Node): string | undefined => {
  if (parameter.type === "Identifier") {
    return parameter.name;
  }
  if (parameter.type === "AssignmentPattern") {
    return parameterName(parameter.left);
  }
  if (parameter.type === "RestElement") {
    return parameterName(parameter.argument);
  }
  if (parameter.type === "TSParameterProperty") {
    return parameterName(parameter.parameter);
  }
  return undefined;
};

const functionParameters = (node: Node): readonly Node[] =>
  "params" in node && Array.isArray(node.params) ? node.params : [];

/** The named function the identifier `name` is a parameter of, and its position. */
const parameterOwner = (
  identifier: Node,
  name: string,
  parents: ReadonlyMap<Node, Node>,
): { helper: Helper; position: number } | undefined => {
  let node = parents.get(identifier);
  while (node !== undefined && !FUNCTION_LIKE.has(node.type)) {
    node = parents.get(node);
  }
  if (node === undefined) {
    return undefined;
  }
  const position = functionParameters(node).findIndex(
    (parameter) => parameterName(parameter) === name,
  );
  if (position === -1) {
    return undefined;
  }
  const parent = parents.get(node);
  if (
    (node.type === "FunctionDeclaration" ||
      node.type === "TSDeclareFunction") &&
    node.id !== null
  ) {
    return {
      helper: {
        name: node.id.name,
        exported:
          parent?.type === "ExportNamedDeclaration" ||
          parent?.type === "ExportDefaultDeclaration",
      },
      position,
    };
  }
  if (
    (node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionExpression") &&
    parent?.type === "VariableDeclarator" &&
    parent.id.type === "Identifier"
  ) {
    const statement = parents.get(parent);
    return {
      helper: {
        name: parent.id.name,
        exported:
          statement !== undefined &&
          parents.get(statement)?.type === "ExportNamedDeclaration",
      },
      position,
    };
  }
  return undefined;
};

const findStatusSites = (file: string, source: string): StatusSite[] => {
  const parsed = parseSource(file, source);
  const text = (node: Node): string => source.slice(node.start, node.end);
  const lineOf = (node: Node): number => parsed.locate(node.start).line;

  // Values a status may name in this file: declarations and assignments.
  const values = new Map<string, Node[]>();
  const calls: Construction[] = [];
  const parents = new Map<Node, Node>();
  walk(parsed.program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (parent !== undefined) {
      parents.set(node, parent);
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init !== null
    ) {
      const name = node.id.name;
      values.set(name, [...(values.get(name) ?? []), node.init]);
    }
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left.type === "Identifier"
    ) {
      const name = node.left.name;
      values.set(name, [...(values.get(name) ?? []), node.right]);
    }
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      calls.push(node);
    }
  });

  const sites: StatusSite[] = [];
  // Same-file helpers that hand a parameter on as the status (or as a whole
  // `ResponseInit`, when `init`), by position.
  const helpers = new Map<string, Map<number, boolean>>();
  const record = (expression: Node, init: boolean): void => {
    if (init && expression.type === "ObjectExpression") {
      const status = statusProperty(expression);
      if (status !== undefined) {
        record(status, false);
      }
      return;
    }
    const owner =
      expression.type === "Identifier"
        ? parameterOwner(expression, expression.name, parents)
        : undefined;
    if (owner !== undefined) {
      const positions =
        helpers.get(owner.helper.name) ?? new Map<number, boolean>();
      positions.set(owner.position, init);
      helpers.set(owner.helper.name, positions);
      // A local helper's callers are all in this file, and scanned instead.
      if (!owner.helper.exported) {
        return;
      }
    }
    const named =
      expression.type === "Identifier"
        ? (values.get(expression.name) ?? [])
        : [];
    const literal =
      containsServerErrorLiteral(expression) ||
      named.some(containsServerErrorLiteral);
    // A whole `ResponseInit` an expression yields is another answer's own,
    // re-framed; only one holding a literal 5xx is built here.
    const numeric =
      expression.type === "Literal" && typeof expression.value === "number";
    if ((init || numeric) && !literal) {
      return;
    }
    sites.push({
      kind: literal ? "literal" : "computed",
      expression: text(expression),
      line: lineOf(expression),
    });
  };

  for (const call of calls) {
    for (const { expression, init } of constructedStatuses(call, source)) {
      record(expression, init);
    }
  }
  // A helper may hand its status to another; follow until nothing is new.
  const followed = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const call of calls) {
      const name = calleeName(call.callee);
      const positions = name === undefined ? undefined : helpers.get(name);
      for (const [position, init] of positions ?? []) {
        const arg = call.arguments[position];
        const key = `${call.start}:${position}`;
        if (arg !== undefined && !followed.has(key)) {
          followed.add(key);
          grew = true;
          record(arg, init);
        }
      }
    }
  }
  return sites.toSorted((left, right) => left.line - right.line);
};

const apiSources = async (): Promise<{ file: string; source: string }[]> =>
  await Promise.all(
    [...new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: API_ROOT })]
      // Tests and their helpers build answers to serve them; none is ours.
      .filter(
        (file) =>
          !/\.(?:test|spec|d|type-test)\.tsx?$/u.test(file) &&
          !file.startsWith("src/tests/") &&
          // Operator commands read answers; they never serve one.
          !file.startsWith("src/scripts/"),
      )
      .toSorted()
      .map(async (file) => ({
        file,
        source: await Bun.file(path.join(API_ROOT, file)).text(),
      })),
  );

describe("server error answers", () => {
  test("finds the status of every answer construction", () => {
    const sample = [
      "status(502);",
      "status(error.status, { message });",
      "status(404);",
      "new HttpStatusResponse(500, body);",
      "new Response(body, { status: 503, headers });",
      "Response.json(body, { status: code });",
      "const status = refused ? 503 : 413;",
      "new Response(body, { status });",
      "mcpJsonRpcErrorResponse({ code, status: 503 });",
      "const respond = (statusCode: number) => new Response(null, { status: statusCode });",
      "respond(500);",
      "export const answer = (code: number) => status(code, body);",
      "new HandlerError({ status: 500, message });",
      "setTimeout(retry, 500);",
      "const markRun = (status: string) => status;",
      "markRun('failed');",
      "new Response(body, { status: 200 });",
      "warmer.status(source, edition);",
      "observedResponse(answer, body, { status: 503 });",
    ].join("\n");
    expect(findStatusSites("sample.ts", sample)).toEqual([
      { kind: "literal", expression: "502", line: 1 },
      { kind: "computed", expression: "error.status", line: 2 },
      { kind: "literal", expression: "500", line: 4 },
      { kind: "literal", expression: "503", line: 5 },
      { kind: "computed", expression: "code", line: 6 },
      { kind: "literal", expression: "status", line: 8 },
      { kind: "literal", expression: "503", line: 9 },
      { kind: "literal", expression: "500", line: 11 },
      { kind: "computed", expression: "code", line: 12 },
    ]);
  });

  test("every 5xx answer is built from its cause", async () => {
    const sources = await apiSources();
    // The scan reached the modules that answer requests.
    expect(sources.some(({ file }) => file === "src/lib/auth.ts")).toBe(true);
    const hits: string[] = [];
    const pendingSeen = new Set<string>();
    const computedSeen = new Set<string>();
    for (const { file, source } of sources) {
      for (const site of findStatusSites(file, source)) {
        if (site.kind === "literal") {
          if (PENDING_LITERAL[file] === undefined) {
            hits.push(
              `${file}:${site.line} builds a ${site.expression} answer without its cause; use ${OWNER_API}`,
            );
          } else {
            pendingSeen.add(file);
          }
        } else if (COMPUTED[file]?.[site.expression] !== undefined) {
          computedSeen.add(`${file}|${site.expression}`);
        } else if (!OWNERS.has(file)) {
          hits.push(
            `${file}:${site.line} builds an answer at computed status \`${site.expression}\`; use ${OWNER_API}, which observes a 5xx, or list why it never answers one`,
          );
        }
      }
    }
    for (const file of Object.keys(PENDING_LITERAL)) {
      if (!pendingSeen.has(file)) {
        hits.push(
          `${file} no longer builds a literal 5xx; remove its pending entry`,
        );
      }
    }
    for (const [file, expressions] of Object.entries(COMPUTED)) {
      for (const expression of Object.keys(expressions)) {
        if (!computedSeen.has(`${file}|${expression}`)) {
          hits.push(
            `${file} no longer builds an answer at \`${expression}\`; remove its entry`,
          );
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
