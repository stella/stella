import { expect, test } from "bun:test";
import * as cheerio from "cheerio";
import fc from "fast-check";

import type { Block } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { validateAst } from "./validate-ast";
import { validateAstReference } from "./validate-ast.reference.test-helper";

const token = fc
  .tuple(
    fc.constantFrom("Latin", "Straße", "CAFÉ"),
    fc.constantFrom("ΛΟΓΟΣ", "ΛΟΓΟ[Σ]", "μέσος", "ΣΟΣ"),
    fc.constantFrom("Кириллица", "Москва", "ДЕЛО"),
    fc.constantFrom("İİİ", "ısı", "İstanbul", "Iıİi"),
    fc.constantFrom("e\u0301lan", "A\u030Angstrom", "z\u0307ebra"),
    fc.constantFrom("an[o]nym", "[О]твет", "[İ]sim", "[OBRÁZEK]"),
    fc.nat(),
  )
  .map(([latin, greek, cyrillic, turkish, combining, bracketed, rotation]) => {
    const words = [latin, greek, cyrillic, turkish, combining, bracketed];
    const offset = rotation % words.length;
    return [...words.slice(offset), ...words.slice(0, offset)].join(" ");
  });

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const blocksFor = (text: string): Block[] => [
  {
    type: "paragraph",
    id: "generated",
    anchorId: "generated",
    inlines: [{ type: "text", text }],
    plainText: text,
  },
];

test("validation normalization matches the pre-reuse implementation", () => {
  assertProperty(
    "validation normalization matches the pre-reuse implementation",
    fc.property(
      fc.array(token, { minLength: 1, maxLength: 5 }),
      fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
      (sourceParts, retained) => {
        const source = sourceParts.join(" \n\u00a0 ");
        const ast = sourceParts
          .filter((_, index) => retained[index % retained.length])
          .join(" ");
        const html = `<p>${escapeHtml(source)}</p>`;
        const blocks = blocksFor(ast);

        const reference = validateAstReference(html, blocks);

        expect(validateAst(html, blocks)).toEqual(reference);
        expect(
          validateAst(html, blocks, { document: cheerio.load(html) }),
        ).toEqual(reference);
      },
    ),
  );
});
