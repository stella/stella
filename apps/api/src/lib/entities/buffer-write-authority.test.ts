import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

const apiRoot = path.resolve(import.meta.dir, "../..");

// Post-write callbacks run after the version and entity writers have taken
// their document and matter locks; authority taken there would invert the
// member → assignment → matter order. It belongs in the writer's `authority`.
const POST_WRITE_CALLBACKS = new Set(["afterWrite", "afterCreate"]);
const AUTHORITY_CALL = /Authority|MemberPermission|MemberAccess/u;

const authorityCallsInPostWriteCallbacks = (file: string, source: string) => {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const collectCalls = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(parsed);
      if (AUTHORITY_CALL.test(callee)) {
        const { line } = parsed.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${file}:${line + 1} ${callee}`);
      }
    }
    ts.forEachChild(node, collectCalls);
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      POST_WRITE_CALLBACKS.has(node.name.text)
    ) {
      collectCalls(node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
};

test("no post-write callback takes authority after the writer's locks", () => {
  const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: apiRoot })].filter(
    (file) => !file.endsWith(".test.ts") && !file.includes("tests/"),
  );
  expect(files.length).toBeGreaterThan(0);
  expect(
    files.flatMap((file) =>
      authorityCallsInPostWriteCallbacks(
        file,
        readFileSync(path.join(apiRoot, file), "utf-8"),
      ),
    ),
  ).toEqual([]);
});

test("the census sees an authority call inside a post-write callback", () => {
  expect(
    authorityCallsInPostWriteCallbacks(
      "fixture.ts",
      "write({ afterWrite: async (tx) => { await holdCurrentWriteAuthority(tx); } });",
    ),
  ).toEqual(["fixture.ts:1 holdCurrentWriteAuthority"]);
  expect(
    authorityCallsInPostWriteCallbacks(
      "fixture.ts",
      "write({ authority: { authorize: async (tx) => { await holdCurrentWriteAuthority(tx); } }, afterWrite: async () => {} });",
    ),
  ).toEqual([]);
});
