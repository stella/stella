/**
 * The client address has one reader: `client-ip.ts`. It decides which peer is
 * trusted, which edge header wins and how the forwarded chain is walked, and
 * stamps the result for everything downstream. A second module that asks the
 * socket for its peer (`requestIP`) or reads `x-forwarded-for` itself would
 * resolve the address by its own rules, so this scan fails on any such module
 * that is not listed below with a reason.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";

const API_ROOT = path.resolve(import.meta.dir, "../..");
/** The one module allowed to resolve the client address. */
const READER = "src/lib/client-ip.ts";
const FORWARDED_FOR = "x-forwarded-for";

/** Modules that touch a raw source for another purpose; each says why. */
const ALLOWED: Readonly<Record<string, string>> = {
  "src/lib/audit-log.ts":
    "keeps the raw forwarded-for chain as audit evidence; the audited address comes from resolveClientIp",
};

type RawRead = { kind: "request-ip" | "forwarded-for"; line: number };

const findRawReads = (file: string, source: string): RawRead[] => {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const reads: RawRead[] = [];
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const visit = (node: ts.Node): void => {
    // `server.requestIP(...)`, `server?.requestIP`, `server["requestIP"]`, or
    // a destructured `{ requestIP }`; type members only describe the shape.
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === "requestIP") ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "requestIP") ||
      (ts.isBindingElement(node) &&
        (node.propertyName ?? node.name).getText(sourceFile) === "requestIP")
    ) {
      reads.push({ kind: "request-ip", line: lineOf(node) });
    }
    if (
      ts.isStringLiteralLike(node) &&
      node.text.trim().toLowerCase() === FORWARDED_FOR
    ) {
      reads.push({ kind: "forwarded-for", line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return reads;
};

const apiSources = async (): Promise<{ file: string; source: string }[]> =>
  await Promise.all(
    [
      ...new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: API_ROOT }),
      ...new Bun.Glob("scripts/**/*.ts").scanSync({ cwd: API_ROOT }),
    ]
      // Tests and their helpers build requests; they never serve one.
      .filter(
        (file) =>
          !/\.(?:test|spec|d)\.tsx?$/u.test(file) &&
          !file.startsWith("src/tests/"),
      )
      .toSorted()
      .map(async (file) => ({
        file,
        source: await Bun.file(path.join(API_ROOT, file)).text(),
      })),
  );

/**
 * Verify values are compared only as equal-length digests through
 * `timingSafeEqual`; an ordinary comparison would let the response time leak
 * how much of a guess matched. Flags `===`, `!==`, `==`, `!=` and
 * `.includes(...)`/`.indexOf(...)` whose operands name a presented or
 * configured value.
 */
const findDirectSecretComparisons = (
  file: string,
  source: string,
): number[] => {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const namesSecret = (node: ts.Node): boolean =>
    /(?:presented|secrets?)\b/iu.test(node.getText(sourceFile));
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    const equality =
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(node.operatorToken.kind) &&
      [node.left, node.right].every(
        (side) =>
          side.kind !== ts.SyntaxKind.NullKeyword &&
          !ts.isNumericLiteral(side) &&
          !(ts.isPropertyAccessExpression(side) && side.name.text === "length"),
      ) &&
      (namesSecret(node.left) || namesSecret(node.right));
    const membership =
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["includes", "indexOf"].includes(node.expression.name.text) &&
      ((ts.isIdentifier(node.expression.expression) &&
        namesSecret(node.expression.expression)) ||
        node.arguments.some(namesSecret));
    if (equality || membership) {
      lines.push(
        sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...new Set(lines)];
};

describe("verify value comparison", () => {
  test("the reader compares verify values only through timingSafeEqual", async () => {
    const source = await Bun.file(path.join(API_ROOT, READER)).text();
    expect(source).toContain(
      "timingSafeEqual(presentedDigest, digest(secret))",
    );
    expect(findDirectSecretComparisons(READER, source)).toEqual([]);
  });

  test("direct comparisons in a fixture are flagged", () => {
    const flagged = (code: string) =>
      findDirectSecretComparisons("src/lib/example.ts", code).length;
    expect(flagged("const ok = presented === secret;")).toBe(1);
    expect(flagged("const ok = secrets.includes(presented);")).toBe(1);
    expect(flagged("const ok = secrets.indexOf(value) !== -1;")).toBe(1);
    expect(flagged("const ok = value === frontendSecret;")).toBe(1);
    expect(
      flagged("const ok = presented === null || secrets.length === 0;"),
    ).toBe(0);
  });
});

describe("client address guard", () => {
  test("only client-ip.ts reads the socket peer or the forwarded chain", async () => {
    const sources = await apiSources();
    expect(sources.some(({ file }) => file === READER)).toBe(true);
    const offenders = sources
      .filter(({ file }) => file !== READER && !(file in ALLOWED))
      .flatMap(({ file, source }) =>
        findRawReads(file, source).map(
          ({ kind, line }) => `${file}:${line} ${kind}`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  test("every allowed module still has the read it is listed for", async () => {
    const sources = new Map(
      (await apiSources()).map(({ file, source }) => [file, source]),
    );
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(reason.length).toBeGreaterThan(0);
      const source = sources.get(file);
      expect(source).toBeDefined();
      expect(findRawReads(file, source ?? "").map(({ kind }) => kind)).toEqual([
        "forwarded-for",
      ]);
    }
  });

  test("the reader itself is seen by the scan", async () => {
    const source = await Bun.file(path.join(API_ROOT, READER)).text();
    const kinds = new Set(findRawReads(READER, source).map(({ kind }) => kind));
    expect(kinds).toEqual(new Set(["request-ip", "forwarded-for"]));
  });

  test("raw reads in a fixture are flagged", () => {
    const file = "src/handlers/example.ts";
    const flagged = (source: string) =>
      findRawReads(file, source).map(({ kind }) => kind);
    expect(flagged(`const ip = server.requestIP(request)?.address;`)).toEqual([
      "request-ip",
    ]);
    expect(flagged(`const ip = server?.["requestIP"](request);`)).toEqual([
      "request-ip",
    ]);
    expect(flagged(`const { requestIP } = server;`)).toEqual(["request-ip"]);
    expect(
      flagged(`const chain = request.headers.get("X-Forwarded-For");`),
    ).toEqual(["forwarded-for"]);
    expect(flagged("const chain = c.req.header(`x-forwarded-for`);")).toEqual([
      "forwarded-for",
    ]);
  });

  test("type members and comments are not reads", () => {
    expect(
      findRawReads(
        "src/handlers/example.ts",
        `// reads x-forwarded-for elsewhere
        type ServerLike = { requestIP: (request: Request) => null };
        interface Peer { requestIP(request: Request): null }`,
      ),
    ).toEqual([]);
  });
});
