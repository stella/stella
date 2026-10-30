import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const PROJECTION =
  "apps/api/src/handlers/case-law/ingestion/retention/sources/planted.ts";

test("a projection may not reach parser code, adapters or AST builders", async () => {
  expect(
    await lintSingleRule(
      "retention-source-independence",
      [
        'import { parseCzNss } from "@/api/handlers/case-law/ingestion/parsers/cz-nss";',
        'import { czNssAdapter } from "../../adapters/cz-nss";',
        'import { paragraph } from "@stll/legal-ast/document-ast";',
        'import { normalizeValidationText } from "@/api/lib/legal-search/parsers/validate-ast";',
        'const lazy = import("@/api/handlers/case-law/ingestion/parsers/pl-tk");',
        'export * from "@/api/lib/legal-search/parsers/text-encoding";',
      ].join("\n"),
      { cwd: "scratch", sourcePath: PROJECTION },
    ),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});

test("a dynamic import through a constant is read, and an unreadable one is rejected", async () => {
  expect(
    await lintSingleRule(
      "retention-source-independence",
      [
        'const PARSER = "@/api/handlers/case-law/ingestion/parsers/cz-nss";',
        "const ALIAS = PARSER;",
        "export const a = await import(PARSER);",
        "export const b = await import(ALIAS);",
        "export const c = await import(`@/api/lib/legal-search/parsers/rtf-reader`);",
        "export const load = async (name: string) => await import(name);",
        'export const d = await import(["@/api/handlers", "case-law"].join("/"));',
      ].join("\n"),
      { cwd: "scratch", sourcePath: PROJECTION },
    ),
  ).toEqual([3, 4, 5, 6, 7]);
});

test("a dynamic import of a readable, allowed module stays allowed", async () => {
  expect(
    await lintSingleRule(
      "retention-source-independence",
      [
        'const PDF_LIBRARY = "@libpdf/core";',
        "export const a = await import(PDF_LIBRARY);",
        'export const b = await import("@/api/lib/type-guards");',
      ].join("\n"),
      { cwd: "scratch", sourcePath: PROJECTION },
    ),
  ).toEqual([]);
});

test("a projection may share types and use text helpers outside the parsers", async () => {
  expect(
    await lintSingleRule(
      "retention-source-independence",
      [
        'import type { ValidationSource } from "@/api/lib/legal-search/parsers/validate-ast";',
        'import type { DocumentAst } from "@stll/legal-ast/document-ast";',
        'import { type CzNssRawEnvelope } from "../../adapters/cz-nss";',
        'import { Result } from "better-result";',
        'import { normalizeUnicode } from "@stll/text-normalize";',
        'import { isRecord } from "@/api/lib/type-guards";',
      ].join("\n"),
      { cwd: "scratch", sourcePath: PROJECTION },
    ),
  ).toEqual([]);
});
