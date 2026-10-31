/**
 * An incoming request's body stream has one owner: `http/request-body.ts`.
 * It meters and re-frames the body once (`reframeBoundedRequest`) and answers
 * whether one is present (`hasRequestBody`). A module that tees the request
 * (`clone()`) or reads its `body` stream itself can lock the stream another
 * reader needs, so this scan fails on any such read outside the owner.
 *
 * Incoming requests are recognized by name: `request`, `req`,
 * `incomingRequest`, `framedRequest`, and any `.request` or `.req` property
 * (`ctx.request`). An outbound request is named for what it is instead.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";

import { type Node, parseSource, walk } from "@stll/scripts/src/syntax-tree";

const API_ROOT = path.resolve(import.meta.dir, "../..");
/** The one module allowed to read an incoming request's body stream. */
const OWNER = "src/http/request-body.ts";
const INCOMING_NAMES = new Set([
  "request",
  "req",
  "incomingRequest",
  "framedRequest",
]);
const STREAM_MEMBERS = new Set(["body", "clone"]);

/** A member access's name: `.body`, or a literal `["body"]`. */
const memberName = (node: Node): string | undefined => {
  if (node.type !== "MemberExpression") {
    return undefined;
  }
  if (!node.computed) {
    return node.property.type === "Identifier" ? node.property.name : undefined;
  }
  const { property } = node;
  if (property.type === "Literal" && typeof property.value === "string") {
    return property.value;
  }
  return property.type === "TemplateLiteral" &&
    property.expressions.length === 0
    ? (property.quasis.at(0)?.value.cooked ?? undefined)
    : undefined;
};

const isIncomingRequest = (node: Node): boolean =>
  (node.type === "Identifier" && INCOMING_NAMES.has(node.name)) ||
  (node.type === "MemberExpression" &&
    !node.computed &&
    (memberName(node) === "request" || memberName(node) === "req"));

type StreamRead = { member: string; line: number };

const findStreamReads = (file: string, source: string): StreamRead[] => {
  const { locate, program, sourceText } = parseSource(file, source);
  const reads: StreamRead[] = [];
  const lineOf = (node: Node): number => locate(node.start).line;
  walk(program, (node) => {
    // `request.body`, `request?.body`, `ctx.request.clone()`, `request["body"]`.
    const member = memberName(node);
    if (
      node.type === "MemberExpression" &&
      member !== undefined &&
      STREAM_MEMBERS.has(member) &&
      isIncomingRequest(node.object)
    ) {
      reads.push({ member, line: lineOf(node) });
    }
    // `const { body } = request`.
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "ObjectPattern" &&
      node.init !== null &&
      isIncomingRequest(node.init)
    ) {
      for (const element of node.id.properties) {
        // The source text of the property name, or of a rest element's
        // binding; a computed name never names a stream member.
        if (element.type === "Property" && element.computed) {
          continue;
        }
        const name =
          element.type === "Property" ? element.key : element.argument;
        const bound = sourceText.slice(name.start, name.end);
        if (STREAM_MEMBERS.has(bound)) {
          reads.push({ member: bound, line: lineOf(element) });
        }
      }
    }
  });
  return reads;
};

const apiSources = async (): Promise<{ file: string; source: string }[]> =>
  await Promise.all(
    [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: API_ROOT })]
      // Tests and their helpers build and inspect requests; they never own
      // a served one.
      .filter(
        (file) =>
          file !== OWNER &&
          !/\.(?:test|d)\.ts$/u.test(file) &&
          !file.startsWith("src/tests/"),
      )
      .toSorted()
      .map(async (file) => ({
        file,
        source: await Bun.file(path.join(API_ROOT, file)).text(),
      })),
  );

const report = ({
  file,
  member,
  line,
}: StreamRead & { file: string }): string =>
  `${file}:${line} ${member === "clone" ? "tees an incoming request with clone()" : "reads an incoming request's body stream"}; use reframeBoundedRequest or hasRequestBody from ${OWNER}, or name an outbound request for what it is`;

describe("incoming request body ownership", () => {
  test("recognizes incoming request stream reads and leaves responses and outbound requests alone", () => {
    const sample = [
      "if (request.body === null) {}",
      "const copy = incomingRequest.clone();",
      "for await (const chunk of ctx.request.body) {}",
      'const stream = req["body"];',
      "const { body, headers } = framedRequest;",
      "const tee = inner.request?.clone();",
      "await response.body?.cancel();",
      "const piped = res.body;",
      "const forwarded = fetched.value.body;",
      "await fetch(url, { body: completion.body });",
      "const node = $(row).clone();",
    ].join("\n");
    expect(findStreamReads("sample.ts", sample)).toEqual([
      { member: "body", line: 1 },
      { member: "clone", line: 2 },
      { member: "body", line: 3 },
      { member: "body", line: 4 },
      { member: "body", line: 5 },
      { member: "clone", line: 6 },
    ]);
  });

  test("only the owner reads an incoming request's body stream", async () => {
    const sources = await apiSources();
    // The scan reached the modules that serve requests.
    expect(sources.some(({ file }) => file === "src/http/input.ts")).toBe(true);
    const hits = sources.flatMap(({ file, source }) =>
      findStreamReads(file, source).map((read) => report({ file, ...read })),
    );
    expect(hits).toEqual([]);
  });
});
