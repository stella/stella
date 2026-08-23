import { describe, expect, test } from "bun:test";

import plugin from "./oxlint.plugin";

type TestNode = {
  type: string;
  callee?: TestNode;
  computed?: boolean;
  expression?: TestNode;
  id?: TestNode;
  init?: TestNode;
  name?: string;
  object?: TestNode;
  parent?: TestNode;
  property?: TestNode;
  typeAnnotation?: TestNode;
  value?: unknown;
};

const identifier = (name: string): TestNode => ({ type: "Identifier", name });
const member = (
  object: TestNode,
  property: string,
  computed = false,
): TestNode => ({
  type: "MemberExpression",
  computed,
  object,
  property: computed
    ? { type: "Literal", value: property }
    : identifier(property),
});
const jsonParseCall = (
  object: TestNode = identifier("JSON"),
  computed = false,
): TestNode => ({
  type: "CallExpression",
  callee: member(object, "parse", computed),
});

const sourceCode = {
  isGlobalReference: ({ name }: TestNode): boolean =>
    name === "JSON" || name === "globalThis",
};

describe("no-double-assertion", () => {
  test("reports assertions that erase through unknown", () => {
    const reports: string[] = [];
    const visitors = plugin.rules["no-double-assertion"].create({
      report: ({ messageId }) => reports.push(messageId),
      sourceCode,
    });

    visitors.TSAsExpression({
      type: "TSAsExpression",
      expression: {
        type: "TSAsExpression",
        expression: identifier("value"),
        typeAnnotation: { type: "TSUnknownKeyword" },
      },
      typeAnnotation: { type: "TSTypeReference" },
    });

    expect(reports).toEqual(["doubleAssertion"]);
  });

  test("allows a single assertion to unknown", () => {
    const reports: string[] = [];
    const visitors = plugin.rules["no-double-assertion"].create({
      report: ({ messageId }) => reports.push(messageId),
      sourceCode,
    });

    visitors.TSAsExpression({
      type: "TSAsExpression",
      expression: identifier("value"),
      typeAnnotation: { type: "TSUnknownKeyword" },
    });

    expect(reports).toEqual([]);
  });
});

describe("no-unchecked-json-parse-typing", () => {
  const reportsFor = (
    parent: TestNode,
    call = jsonParseCall(),
    isGlobalReference = sourceCode.isGlobalReference,
  ): string[] => {
    const reports: string[] = [];
    const visitors = plugin.rules["no-unchecked-json-parse-typing"].create({
      report: ({ messageId }) => reports.push(messageId),
      sourceCode: { isGlobalReference },
    });
    call.parent = parent;
    if (parent.type === "TSAsExpression" || parent.type === "TSTypeAssertion") {
      parent.expression = call;
    }
    if (parent.type === "VariableDeclarator") {
      parent.init = call;
    }
    visitors.CallExpression(call);
    return reports;
  };

  test("reports direct domain assertions", () => {
    expect(
      reportsFor({
        type: "TSAsExpression",
        typeAnnotation: { type: "TSTypeReference" },
      }),
    ).toEqual(["uncheckedParse"]);
  });

  test("does not treat any as boundary validation", () => {
    expect(
      reportsFor({
        type: "TSAsExpression",
        typeAnnotation: { type: "TSAnyKeyword" },
      }),
    ).toEqual(["uncheckedParse"]);
  });

  test("reports satisfies because JSON.parse returns any", () => {
    expect(reportsFor({ type: "TSSatisfiesExpression" })).toEqual([
      "uncheckedParse",
    ]);
  });

  test("reports untyped and domain-annotated assignments", () => {
    expect(
      reportsFor({
        type: "VariableDeclarator",
        id: identifier("inferred"),
      }),
    ).toEqual(["uncheckedParse"]);
    expect(
      reportsFor({
        type: "VariableDeclarator",
        id: {
          ...identifier("annotated"),
          typeAnnotation: {
            type: "TSTypeAnnotation",
            typeAnnotation: { type: "TSTypeReference" },
          },
        },
      }),
    ).toEqual(["uncheckedParse"]);
  });

  test("reports direct returns and nested arguments", () => {
    expect(reportsFor({ type: "ReturnStatement" })).toEqual(["uncheckedParse"]);
    expect(reportsFor({ type: "CallExpression" })).toEqual(["uncheckedParse"]);
  });

  test("reports computed and globalThis JSON.parse calls", () => {
    expect(
      reportsFor({ type: "ReturnStatement" }, jsonParseCall(undefined, true)),
    ).toEqual(["uncheckedParse"]);
    expect(
      reportsFor(
        { type: "ReturnStatement" },
        jsonParseCall(member(identifier("globalThis"), "JSON")),
      ),
    ).toEqual(["uncheckedParse"]);
    expect(
      reportsFor(
        { type: "ReturnStatement" },
        jsonParseCall(member(identifier("globalThis"), "JSON", true), true),
      ),
    ).toEqual(["uncheckedParse"]);
  });

  test("ignores locally shadowed JSON and globalThis bindings", () => {
    const isGlobalReference = (): boolean => false;
    expect(
      reportsFor(
        { type: "ReturnStatement" },
        jsonParseCall(),
        isGlobalReference,
      ),
    ).toEqual([]);
    expect(
      reportsFor(
        { type: "ReturnStatement" },
        jsonParseCall(member(identifier("globalThis"), "JSON")),
        isGlobalReference,
      ),
    ).toEqual([]);
  });

  test("allows parse-to-unknown before validation", () => {
    expect(
      reportsFor({
        type: "VariableDeclarator",
        id: {
          ...identifier("value"),
          typeAnnotation: {
            type: "TSTypeAnnotation",
            typeAnnotation: { type: "TSUnknownKeyword" },
          },
        },
      }),
    ).toEqual([]);
    expect(
      reportsFor({
        type: "TSAsExpression",
        typeAnnotation: { type: "TSUnknownKeyword" },
      }),
    ).toEqual([]);
    expect(
      reportsFor({
        type: "TSTypeAssertion",
        typeAnnotation: { type: "TSUnknownKeyword" },
      }),
    ).toEqual([]);
  });
});
