import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string) =>
  lintSingleRule("no-optional-chain-null-compare", source, {
    sourcePath: "source.ts",
  });

test("rejects a strict null comparison against an optional chain, on either side", async () => {
  expect(
    await lint(
      "declare const log: { closedAt: Date | null } | undefined;\nexport const open = log?.closedAt !== null;",
    ),
  ).toEqual([2]);
  expect(
    await lint(
      "declare const log: { closedAt: Date | null } | undefined;\nexport const open = null === log?.closedAt;",
    ),
  ).toEqual([2]);
  expect(
    await lint(
      "declare const node: Element | null;\nexport const nested = node?.parentElement?.closest('a') !== null;",
    ),
  ).toEqual([2]);
});

test("allows a narrowed object, folded absence and undefined comparisons", async () => {
  expect(
    await lint(
      [
        "declare const log: { closedAt: Date | null } | undefined;",
        "export const a = log !== undefined && log.closedAt !== null;",
        "export const b = (log?.closedAt ?? null) !== null;",
        "export const c = log?.closedAt !== undefined;",
        "export const d = log?.closedAt;",
      ].join("\n"),
    ),
  ).toEqual([]);
});
