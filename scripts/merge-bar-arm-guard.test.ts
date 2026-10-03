import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const HANDOFF_OPERATIONS = [
  "enablePullRequestAutoMerge",
  "enqueuePullRequest",
] as const;

const handoffOwnershipErrors = (source: string) => {
  const file = ts.createSourceFile(
    "merge-bar.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const errors: string[] = [];
  const owners: ts.VariableDeclaration[] = [];
  const visit = (
    node: ts.Node,
    enclosingOwner: ts.VariableDeclaration | null,
  ) => {
    let owner = enclosingOwner;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "armAndVerify"
    ) {
      owners.push(node);
      owner = node;
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const text = node.getText(file);
      for (const operation of HANDOFF_OPERATIONS) {
        if (!new RegExp(`\\b${operation}\\s*\\(`, "u").test(text)) {
          continue;
        }
        if (owner === null) {
          errors.push(`${operation} outside armAndVerify`);
        }
        if (!text.includes("expectedHeadOid:$sha")) {
          errors.push(`${operation} missing exact-head pin`);
        }
      }
      if (ts.isStringLiteralLike(node) && node.text === "--auto") {
        errors.push("auto-merge CLI bypass");
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let name = "";
      if (ts.isIdentifier(callee)) {
        name = callee.text;
      } else if (ts.isPropertyAccessExpression(callee)) {
        name = callee.name.text;
      }
      if (
        HANDOFF_OPERATIONS.some((operation) => operation === name) &&
        owner === null
      ) {
        errors.push(`${name} outside armAndVerify`);
      }
    }
    ts.forEachChild(node, (child) => visit(child, owner));
  };
  visit(file, null);
  if (owners.length !== 1) {
    errors.push("expected exactly one armAndVerify owner");
  }
  return errors;
};

const source = readFileSync(new URL("merge-bar.ts", import.meta.url), "utf-8");

describe("merge handoff mutation ownership", () => {
  test("only the verifier owns exact-head arming and enqueue writes", () => {
    expect(handoffOwnershipErrors(source)).toEqual([]);
  });
  test.each(HANDOFF_OPERATIONS)(
    "a %s mutation outside the owner is rejected",
    (operation) => {
      expect(
        handoffOwnershipErrors(
          `${source}\nconst bypass = 'mutation { ${operation}(input:{expectedHeadOid:$sha}) }';`,
        ),
      ).toContain(`${operation} outside armAndVerify`);
      expect(
        handoffOwnershipErrors(`${source}\ngateway.${operation}();`),
      ).toContain(`${operation} outside armAndVerify`);
    },
  );
  test("a head pin cannot be removed from either owned mutation", () => {
    expect(
      handoffOwnershipErrors(source.replaceAll("expectedHeadOid:$sha", "")),
    ).toEqual(
      HANDOFF_OPERATIONS.map(
        (operation) => `${operation} missing exact-head pin`,
      ).toReversed(),
    );
  });
  test("the old CLI bypass is rejected", () => {
    expect(
      handoffOwnershipErrors(
        `${source}\nconst args = ['pr', 'merge', '--auto'];`,
      ),
    ).toContain("auto-merge CLI bypass");
  });
});
