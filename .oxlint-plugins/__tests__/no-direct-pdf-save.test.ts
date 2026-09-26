import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (
  lines: readonly string[],
  sourcePath = "apps/api/src/lib/files/derive.ts",
) =>
  await lintSingleRule("no-direct-pdf-save", [...lines, ""].join("\n"), {
    sourcePath,
  });

describe.serial("no-direct-pdf-save", () => {
  test("reports saves of loaded, created, merged and extracted documents", async () => {
    expect(
      await lint([
        'import { PDF as Doc } from "@libpdf/core";',
        "declare const bytes: Uint8Array;",
        "export const a = async () => {",
        "  const loaded = await Doc.load(bytes);",
        "  await loaded.save();",
        "  const created = Doc.create();",
        "  await created?.save({ subsetFonts: true });",
        "  const page = await loaded.extractPages([0]);",
        '  await page["save"]();',
        "  await (await Doc.merge([bytes])).save();",
        "};",
      ]),
    ).toEqual([5, 7, 9, 10]);
  });

  test("reports aliases of save and documents typed as PDF", async () => {
    expect(
      await lint([
        'import type { PDF } from "@libpdf/core";',
        'import { PDF as Doc } from "@libpdf/core";',
        "export const b = async (pdf: PDF) => {",
        "  const write = pdf.save;",
        "  const { save } = pdf;",
        "  const viaPrototype = Doc.prototype.save;",
        "  return [write, save, viaPrototype];",
        "};",
      ]),
    ).toEqual([4, 5, 6]);
  });

  test("reports other PDF writers and rewriting command lines", async () => {
    expect(
      await lint([
        'import { PDFDocument } from "pdf-lib";',
        "declare const $: (parts: TemplateStringsArray) => unknown;",
        "export const c = async () => {",
        '  const kit = await import("pdfkit");',
        '  Bun.spawn(["qpdf", "--linearize", "in.pdf", "out.pdf"]);',
        "  $`gs -sDEVICE=pdfwrite -o out.pdf in.pdf`;",
        "  return [PDFDocument, kit];",
        "};",
      ]),
    ).toEqual([1, 4, 5, 6]);
  });

  test("accepts unrelated saves, comments, strings, and PDF reads", async () => {
    expect(
      await lint([
        'import { PDF } from "@libpdf/core";',
        "declare const store: { save: (value: string) => Promise<void> };",
        "declare const bytes: Uint8Array;",
        "export const d = async () => {",
        "  // pdf.save() would break a signature",
        '  const hint = "call pdf.save() through the helper";',
        "  await store.save(hint);",
        "  const pdf = await PDF.load(bytes);",
        "  return pdf.getPageCount();",
        "};",
      ]),
    ).toEqual([]);
  });

  test("leaves the owner module and tests alone", async () => {
    const source = [
      'import type { PDF } from "@libpdf/core";',
      "export const e = async (pdf: PDF) => await pdf.save();",
    ];
    expect(
      await lint(source, "apps/api/src/lib/files/pdf-signatures.ts"),
    ).toEqual([]);
    expect(await lint(source, "apps/api/src/lib/files/derive.test.ts")).toEqual(
      [],
    );
    expect(await lint(source)).toEqual([2]);
  });
});
