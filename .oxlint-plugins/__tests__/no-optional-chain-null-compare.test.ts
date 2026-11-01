import { panic } from "better-result";
import { expect, test } from "bun:test";

import {
  type ChainComparisonOperator,
  chainComparisonOwner,
  type NullishLiteral,
} from "../no-optional-chain-null-compare.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const RULES = [
  "no-optional-chain-null-compare",
  "no-optional-chain-absent-match",
] as const;

const lint = async (rule: (typeof RULES)[number], source: string) =>
  lintSingleRule(rule, source, {
    plugin: "no-optional-chain-null-compare",
    sourcePath: "source.ts",
  });

const OPERATORS = [
  "===",
  "!==",
  "==",
  "!=",
] as const satisfies readonly ChainComparisonOperator[];
const LITERALS = [
  "null",
  "undefined",
] as const satisfies readonly NullishLiteral[];
const FORMS = OPERATORS.flatMap((operator) =>
  LITERALS.map((literal) => ({ operator, literal })),
);

/** What `x?.y <operator> <literal>` yields when `x` is absent. */
const whenAbsent = (
  operator: ChainComparisonOperator,
  literal: NullishLiteral,
): boolean => {
  const absent: unknown = undefined;
  const value = literal === "null" ? null : undefined;
  switch (operator) {
    case "===":
      return absent === value;
    case "!==":
      return absent !== value;
    case "==":
      // oxlint-disable-next-line eqeqeq -- the loose operator is the subject
      return absent == value;
    case "!=":
      // oxlint-disable-next-line eqeqeq -- the loose operator is the subject
      return absent != value;
    default:
      operator satisfies never;
      return panic("Unhandled comparison operator");
  }
};

const DECLARATION =
  "declare const log: { closedAt: Date | null | undefined } | undefined;";

test("a form belongs to this plugin exactly when an absent object compares true", () => {
  for (const { operator, literal } of FORMS) {
    const form = `x?.y ${operator} ${literal}`;
    expect({
      form,
      owned:
        chainComparisonOwner(operator, literal) !== "prefer-optional-chain",
    }).toEqual({ form, owned: whenAbsent(operator, literal) });
  }
  expect(chainComparisonOwner("!==", "null")).toBe(
    "no-optional-chain-null-compare",
  );
});

test("each rule flags an optional chain comparison exactly for the forms it owns, on either side", async () => {
  const lines = FORMS.flatMap(({ operator, literal }, index) => [
    `export const a${String(index)} = log?.closedAt ${operator} ${literal};`,
    `export const b${String(index)} = ${literal} ${operator} log?.closedAt;`,
  ]);
  const source = [DECLARATION, ...lines].join("\n");
  const reported = await Promise.all(
    RULES.map(async (rule) => ({ rule, lines: await lint(rule, source) })),
  );
  expect(reported).toEqual(
    RULES.map((rule) => ({
      rule,
      lines: FORMS.flatMap(({ operator, literal }, index) =>
        chainComparisonOwner(operator, literal) === rule
          ? [2 + index * 2, 3 + index * 2]
          : [],
      ),
    })),
  );
});

test("allows a narrowed object, folded absence and the comparisons prefer-optional-chain owns", async () => {
  const source = [
    "declare const log: { closedAt: Date | null } | undefined;",
    "export const a = log !== undefined && log.closedAt !== null;",
    "export const b = (log?.closedAt ?? null) !== null;",
    "export const c = log?.closedAt !== undefined;",
    "export const d = log?.closedAt === null;",
    "export const e = log?.closedAt;",
    "export const f = (log?.closedAt ?? undefined) === undefined;",
  ].join("\n");
  const reported = await Promise.all(
    RULES.map(async (rule) => ({ rule, lines: await lint(rule, source) })),
  );
  expect(reported).toEqual(RULES.map((rule) => ({ rule, lines: [] })));
});

test("flags a nested chain", async () => {
  expect(
    await lint(
      "no-optional-chain-null-compare",
      "declare const node: Element | null;\nexport const nested = node?.parentElement?.closest('a') !== null;",
    ),
  ).toEqual([2]);
});
