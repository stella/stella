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
import ts from "typescript6";

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
  "src/handlers/case-law/ingestion/adapters/test-utils.ts": {
    "match.status ?? 200": "a test double's upstream answer, never served",
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

const isServerErrorLiteral = (node: ts.Node): boolean =>
  ts.isNumericLiteral(node) && SERVER_ERROR_LITERAL.test(node.text);

const containsServerErrorLiteral = (node: ts.Node): boolean =>
  isServerErrorLiteral(node) ||
  (ts.forEachChild(node, (child) =>
    containsServerErrorLiteral(child) ? true : undefined,
  ) ??
    false);

const calleeName = (expression: ts.Expression): string | undefined => {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
};

const statusProperty = (node: ts.Node): ts.Expression | undefined => {
  if (!ts.isObjectLiteralExpression(node)) {
    return undefined;
  }
  for (const property of node.properties) {
    if (property.name?.getText() !== "status") {
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      return property.initializer;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      return property.name;
    }
  }
  return undefined;
};

type Constructed = {
  readonly expression: ts.Expression;
  readonly init: boolean;
};

/**
 * The status expressions a call or construction builds an answer with; an
 * `init` one is a whole `ResponseInit`.
 */
const constructedStatuses = (
  node: ts.CallExpression | ts.NewExpression,
): Constructed[] => {
  const name = calleeName(node.expression);
  const args = node.arguments ?? [];
  const [first, second] = args;
  if (
    first !== undefined &&
    ((ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      name === "status") ||
      (ts.isNewExpression(node) && name === "HttpStatusResponse"))
  ) {
    return [{ expression: first, init: false }];
  }
  if (
    name === "Response" ||
    (name === "json" && node.expression.getText() === "Response.json")
  ) {
    return second === undefined ? [] : [{ expression: second, init: true }];
  }
  // The owner's own constructors take the status beside the cause.
  if (
    name !== undefined &&
    /Response$/u.test(name) &&
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

const hasExportModifier = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );

/** The named function `identifier` is a parameter of, and its position. */
const parameterOwner = (
  identifier: ts.Identifier,
): { helper: Helper; position: number } | undefined => {
  let node: ts.Node | undefined = identifier.parent;
  while (node !== undefined && !ts.isFunctionLike(node)) {
    node = node.parent;
  }
  if (node === undefined) {
    return undefined;
  }
  const position = node.parameters.findIndex(
    (parameter) =>
      ts.isIdentifier(parameter.name) &&
      parameter.name.text === identifier.text,
  );
  if (position === -1) {
    return undefined;
  }
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
    return {
      helper: { name: node.name.text, exported: hasExportModifier(node) },
      position,
    };
  }
  const declaration = node.parent;
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name)
  ) {
    return {
      helper: {
        name: declaration.name.text,
        exported: hasExportModifier(declaration.parent.parent),
      },
      position,
    };
  }
  return undefined;
};

const findStatusSites = (file: string, source: string): StatusSite[] => {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;

  // Values a status may name in this file: declarations and assignments.
  const values = new Map<string, ts.Expression[]>();
  const calls: (ts.CallExpression | ts.NewExpression)[] = [];
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const name = node.name.text;
      values.set(name, [...(values.get(name) ?? []), node.initializer]);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const name = node.left.text;
      values.set(name, [...(values.get(name) ?? []), node.right]);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      calls.push(node);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const sites: StatusSite[] = [];
  // Same-file helpers that hand a parameter on as the status (or as a whole
  // `ResponseInit`, when `init`), by position.
  const helpers = new Map<string, Map<number, boolean>>();
  const record = (expression: ts.Expression, init: boolean): void => {
    if (init && ts.isObjectLiteralExpression(expression)) {
      const status = statusProperty(expression);
      if (status !== undefined) {
        record(status, false);
      }
      return;
    }
    const owner = ts.isIdentifier(expression)
      ? parameterOwner(expression)
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
    const named = ts.isIdentifier(expression)
      ? (values.get(expression.text) ?? [])
      : [];
    const literal =
      containsServerErrorLiteral(expression) ||
      named.some(containsServerErrorLiteral);
    // A whole `ResponseInit` an expression yields is another answer's own,
    // re-framed; only one holding a literal 5xx is built here.
    if ((init || ts.isNumericLiteral(expression)) && !literal) {
      return;
    }
    sites.push({
      kind: literal ? "literal" : "computed",
      expression: expression.getText(sourceFile),
      line: lineOf(expression),
    });
  };

  for (const call of calls) {
    for (const { expression, init } of constructedStatuses(call)) {
      record(expression, init);
    }
  }
  // A helper may hand its status to another; follow until nothing is new.
  const followed = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const call of calls) {
      const name = calleeName(call.expression);
      const positions = name === undefined ? undefined : helpers.get(name);
      for (const [position, init] of positions ?? []) {
        const arg = call.arguments?.[position];
        const key = `${call.pos}:${position}`;
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
