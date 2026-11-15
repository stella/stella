import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string) =>
  lintSingleRule("no-template-block-anchor", source, {
    sourcePath: "parser.ts",
  });

const DECLARATIONS = `declare const index: number;
declare const prefix: string;
declare const anchorId: string;
`;

test("reports a hand-minted positional block anchor", async () => {
  expect(
    await lint(`${DECLARATIONS}export const a = \`p-\${index}\`;`),
  ).toEqual([4]);
  expect(await lint(`${DECLARATIONS}export const a = \`h\${index}\`;`)).toEqual(
    [4],
  );
  expect(
    await lint(`${DECLARATIONS}export const a = \`\${prefix}-p\${index}\`;`),
  ).toEqual([4]);
  expect(
    await lint(`${DECLARATIONS}export const a = \`\${prefix}t-\${index}\`;`),
  ).toEqual([4]);
});

test("accepts publisher spellings and prefixing an existing anchor", async () => {
  expect(
    await lint(`${DECLARATIONS}export const a = \`point\${index}\`;`),
  ).toEqual([]);
  expect(
    await lint(`${DECLARATIONS}export const a = \`fn-\${index}\`;`),
  ).toEqual([]);
  expect(
    await lint(`${DECLARATIONS}export const a = \`\${prefix}\${anchorId}\`;`),
  ).toEqual([]);
  expect(await lint(`${DECLARATIONS}export const a = \`p-1\`;`)).toEqual([]);
});
