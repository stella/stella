import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const OWNER = "apps/api/src/lib/case-law/plain-text.ts";
const lint = async (source: string, sourcePath = "adapter.ts") =>
  await lintSingleRule("no-forged-plain-text", source, { sourcePath });

describe.serial("PlainText construction belongs to the sanitizer", () => {
  test.each([
    "raw as PlainText",
    "<PlainText>raw",
    "raw as unknown as PlainText",
    "raw as Readonly<{ title: PlainText }>",
    "raw as (PlainText | null)",
    "raw as texts.PlainText",
    "raw as IngestionResult",
    "raw as PlainTextMetadataValue",
    "raw as types.IngestionResult",
    "raw as types.PlainTextMetadataValue",
  ])("rejects assertion %s", async (expression) => {
    expect(await lint(`export const forged = ${expression};`)).toEqual([1]);
  });

  test("follows imported and forward local aliases", async () => {
    expect(
      await lint(
        [
          'import type { PlainText as Sanitized } from "./plain-text";',
          "export const forged = raw as Last;",
          "type Last = First;",
          "type First = { title: Sanitized };",
        ].join("\n"),
      ),
    ).toEqual([2]);
  });

  test.each(["IngestionResult", "PlainTextMetadataValue"])(
    "rejects indirect proof of %s through predicates and aliases",
    async (type) => {
      expect(
        await lint(
          [
            `import type { ${type} as Claimed } from "./boundary";`,
            "type Alias = Claimed;",
            "export const isValue = (raw: unknown): raw is Alias => true;",
            "export const forged = raw as Alias;",
            `export const isNamespaced = (raw: unknown): raw is boundary.${type} => true;`,
          ].join("\n"),
        ),
      ).toEqual([3, 4, 5]);
    },
  );

  test("cyclic aliases terminate without dropping other branches", async () => {
    expect(
      await lint(
        [
          "type A = B;",
          "type B = A | PlainText;",
          "export const forged = raw as A;",
        ].join("\n"),
      ),
    ).toEqual([3]);
  });

  test.each([
    "interface Box { value: PlainText }",
    "interface Box extends Base {}; interface Base { value: PlainText }",
    "type Box = Extended; interface Extended extends Base {}; type Base = { value: PlainText }",
    "interface Box extends Base {}; type Base = Nested; interface Nested { value: PlainText }",
    "interface Box { count: number }; interface Box { value: PlainText }",
    "interface Box { value: PlainText }; interface Box { count: number }",
    "interface Box extends Cycle {}; interface Cycle extends Box { value: PlainText }",
  ])("follows interface proof through %s", async (declarations) => {
    expect(
      await lint(
        [
          "export const forged = raw as Box;",
          "export const isBox = (raw: unknown): raw is Box => true;",
          declarations,
        ].join("\n"),
      ),
    ).toEqual([1, 2]);
  });

  test("accepts interface assertions without sanitizer proof", async () => {
    expect(
      await lint(
        [
          "interface Box extends Cycle { count: number }",
          "interface Cycle extends Box { label: string }",
          "type Alias = Box;",
          "export const count = raw as Alias;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("rejects predicates and renamed exports that invent proof", async () => {
    expect(
      await lint(
        [
          "export const isText = (raw: string): raw is PlainText => true;",
          "export function assertText(raw: string): asserts raw is PlainText {}",
          'export type { PlainText as Sanitized } from "./plain-text";',
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3]);
  });

  test("rejects parallel brand definitions", async () => {
    expect(
      await lint(
        'export type PlainText = string & { readonly __brand: "PlainText" };',
      ),
    ).toEqual([1]);
    expect(await lint("export interface PlainText { text: string };")).toEqual([
      1,
    ]);
  });

  test("accepts sanitized value flow and ordinary assertions", async () => {
    expect(
      await lint(
        [
          "type Alias = PlainText;",
          "declare const sanitized: PlainText;",
          "export const title: Alias = sanitized;",
          "export const count = raw as number;",
          "export type { PlainText };",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("only the exact owner may assert the brand", async () => {
    const source = "export const constructed = raw as PlainText;";
    expect(await lint(source, OWNER)).toEqual([]);
    expect(await lint(source, `${OWNER}.other.ts`)).toEqual([1]);
    expect(
      await lint(source, "apps/api/src/lib/case-law/plain-text.test.ts"),
    ).toEqual([1]);
  });
});
