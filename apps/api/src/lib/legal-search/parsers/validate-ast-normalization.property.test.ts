import { expect, test } from "bun:test";
import * as cheerio from "cheerio";
import fc from "fast-check";

import type { Block } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { validateAst } from "./validate-ast";

// Copied from the implementation immediately before document reuse was added.
const referenceNormalize = (text: string): string =>
  text
    .replace(/\s+/gu, " ")
    .replace(/\u00a0/gu, " ")
    .trim()
    .toLowerCase();

const REFERENCE_SKIP_WORDS = new Set([
  "[obrázek]",
  "obrázek",
  "česká",
  "republika",
  "jménem",
  "republiky",
  "pokračování",
]);
const REFERENCE_LETTER = /\p{L}/u;
const referenceTrimNonLetters = (word: string): string => {
  let start = 0;
  let end = word.length;
  while (start < end && !REFERENCE_LETTER.test(word.charAt(start))) {
    start += 1;
  }
  while (end > start && !REFERENCE_LETTER.test(word.charAt(end - 1))) {
    end -= 1;
  }
  return word.slice(start, end);
};
const referenceSeparateSkipMarkers = (text: string): string => {
  let separated = "";
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("[", index);
    const close = open === -1 ? -1 : text.indexOf("]", open + 1);
    if (close === -1) {
      return separated + text.slice(index);
    }
    const marker = referenceTrimNonLetters(
      text.slice(open + 1, close).toLowerCase(),
    );
    separated +=
      text.slice(index, open) +
      (REFERENCE_SKIP_WORDS.has(marker) ? " " : text.slice(open, close + 1));
    index = close + 1;
  }
  return separated;
};
const referenceExtractWords = (text: string): Set<string> => {
  const words = new Set<string>();
  for (const word of referenceSeparateSkipMarkers(text).split(/\s+/u)) {
    const noBrackets = word.replace(/[[\]]/gu, "");
    const clean = referenceTrimNonLetters(noBrackets.toLowerCase());
    if (
      clean.length >= 3 &&
      !/^\d+$/u.test(clean) &&
      !REFERENCE_SKIP_WORDS.has(clean) &&
      !/^\[\d+\]$/u.test(word.toLowerCase())
    ) {
      words.add(clean);
    }
  }
  return words;
};

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

        // The copied helpers form the old normalization oracle. Exercising the
        // word helper explicitly ensures this remains a word and length guard.
        expect(
          referenceExtractWords(referenceNormalize(source)).size,
        ).toBeGreaterThan(0);
        const referenceHtml = `<p>${escapeHtml(referenceNormalize(source))}</p>`;
        const reference = validateAst(
          referenceHtml,
          blocksFor(referenceNormalize(ast)),
        );
        // Work counters measure source traversal before normalization; the old
        // validator therefore reports them from the original-cased document.
        reference.stats.work = validateAst(html, blocks).stats.work;

        expect(validateAst(html, blocks)).toEqual(reference);
        expect(
          validateAst(html, blocks, { document: cheerio.load(html) }),
        ).toEqual(reference);
      },
    ),
  );
});
