import { describe, expect, test } from "bun:test";

import {
  escapeAndHighlight,
  HIGHLIGHT_START,
  HIGHLIGHT_STOP,
  restoreOriginalSearchPreview,
  SEARCH_PREVIEW_FRAGMENT_DELIMITER,
  SEARCH_PREVIEW_FRAGMENT_SEPARATOR,
  SEARCH_PREVIEW_HEADLINE_CONFIG,
  truncateSearchPreviewAroundLexemes,
} from "./highlight";

describe("search result highlighting", () => {
  test("centers a bounded preview around a normalized late match", () => {
    const source = `${"a".repeat(20_000)} odštěpení ${"b".repeat(20_000)}`;
    const preview = truncateSearchPreviewAroundLexemes({
      lexemes: ["odstepeni"],
      maxLength: 16_000,
      source,
    });

    expect(preview).toContain("odštěpení");
    expect(preview.length).toBeLessThanOrEqual(16_000);
    expect(preview).not.toBe("a".repeat(16_000));
  });

  test("anchors locator prefixes at lexical boundaries", () => {
    const source = `educate ${"a".repeat(20_000)} catapult`;
    const preview = truncateSearchPreviewAroundLexemes({
      lexemes: ["cat"],
      maxLength: 16_000,
      source,
    });

    expect(preview).toContain("catapult");
    expect(preview).not.toContain("educate");
  });

  test("maps length-changing Arabic folds back to the source", () => {
    const source = `${"a".repeat(20_000)} مـحـمـد`;
    const preview = truncateSearchPreviewAroundLexemes({
      lexemes: ["محمد"],
      maxLength: 16_000,
      source,
    });

    expect(preview).toContain("مـحـمـد");
  });

  test("does not split surrogate pairs in a fallback preview", () => {
    const source = `${"a".repeat(15_999)}😀 trailing`;
    const preview = truncateSearchPreviewAroundLexemes({
      lexemes: ["absent"],
      maxLength: 16_000,
      source,
    });

    expect(preview).toBe("a".repeat(15_999));
    expect(preview).not.toContain("\u{d83d}");
  });

  test("escapes HTML before inserting highlight tags", () => {
    const highlighted = escapeAndHighlight(
      `<script>alert("x")</script> ${HIGHLIGHT_START}Privileged & confidential${HIGHLIGHT_STOP}`,
    );

    expect(highlighted).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; <mark>Privileged &amp; confidential</mark>",
    );
  });

  test("escapes apostrophes and unmatched markers without dropping text", () => {
    expect(escapeAndHighlight(`Client's ${HIGHLIGHT_START}draft`)).toBe(
      "Client&#x27;s <mark>draft",
    );
  });

  test("separates preview fragments with real paragraph breaks", () => {
    expect(SEARCH_PREVIEW_HEADLINE_CONFIG).toContain(
      `FragmentDelimiter="${SEARCH_PREVIEW_FRAGMENT_DELIMITER}", `,
    );
    expect(SEARCH_PREVIEW_HEADLINE_CONFIG).not.toContain("\n");
  });

  test("restores normalized Latin highlights onto the original source", () => {
    expect(
      restoreOriginalSearchPreview({
        headline: `the ${HIGHLIGHT_START}resume${HIGHLIGHT_STOP} was approved.`,
        maxLength: 1000,
        normalizedSource: "the resume was approved.",
        source: "The résumé was approved.",
        useUnaccent: true,
      }),
    ).toBe(`The ${HIGHLIGHT_START}résumé${HIGHLIGHT_STOP} was approved.`);
  });

  test("restores PostgreSQL unaccent transliterations beyond Unicode decomposition", () => {
    expect(
      restoreOriginalSearchPreview({
        headline: `${HIGHLIGHT_START}Lodz${HIGHLIGHT_STOP} and ${HIGHLIGHT_START}AE${HIGHLIGHT_STOP}sir`,
        maxLength: 1000,
        normalizedSource: "Lodz and AEsir",
        source: "Łódź and Æsir",
        useUnaccent: true,
      }),
    ).toBe(
      `${HIGHLIGHT_START}Łódź${HIGHLIGHT_STOP} and ${HIGHLIGHT_START}Æ${HIGHLIGHT_STOP}sir`,
    );
  });

  test("restores unaccent rules absent from Unicode normalization", () => {
    expect(
      restoreOriginalSearchPreview({
        headline: `${HIGHLIGHT_START}Zazou${HIGHLIGHT_STOP} and ${HIGHLIGHT_START}zydeco${HIGHLIGHT_STOP}`,
        maxLength: 1000,
        normalizedSource: "Zazou and zydeco",
        source: "Ƶazou and ƶydeco",
        useUnaccent: true,
      }),
    ).toBe(
      `${HIGHLIGHT_START}Ƶazou${HIGHLIGHT_STOP} and ${HIGHLIGHT_START}ƶydeco${HIGHLIGHT_STOP}`,
    );
  });

  test("preserves positions across consecutive one-to-one unaccent folds", () => {
    expect(
      restoreOriginalSearchPreview({
        headline: `Zz${HIGHLIGHT_START}Zz${HIGHLIGHT_STOP}`,
        maxLength: 1000,
        normalizedSource: "ZzZz",
        source: "ƵƶƵƶ",
        useUnaccent: true,
      }),
    ).toBe(`Ƶƶ${HIGHLIGHT_START}Ƶƶ${HIGHLIGHT_STOP}`);
  });

  test("aligns repeated PostgreSQL-only folds in linear time", () => {
    const repetitions = 20_000;
    const normalizedSource = "Za".repeat(repetitions);
    const source = "Ƶa".repeat(repetitions);

    expect(
      restoreOriginalSearchPreview({
        headline: `${HIGHLIGHT_START}Za${HIGHLIGHT_STOP}`,
        maxLength: 1000,
        normalizedSource,
        source,
        useUnaccent: true,
      }),
    ).toBe(`${HIGHLIGHT_START}Ƶa${HIGHLIGHT_STOP}`);
  });

  test("restores Arabic-folded highlights with original orthography", () => {
    expect(
      restoreOriginalSearchPreview({
        headline: `قرار ${HIGHLIGHT_START}احمد${HIGHLIGHT_STOP} النهايي`,
        maxLength: 1000,
        normalizedSource: "قرار احمد النهايي",
        source: "قرار أَحْمَد النهائي",
        useUnaccent: true,
      }),
    ).toBe(`قرار ${HIGHLIGHT_START}أَحْمَد${HIGHLIGHT_STOP} النهائي`);
  });

  test("restores ordered fragments and renders their paragraph separator", () => {
    expect(
      restoreOriginalSearchPreview({
        headline: `${HIGHLIGHT_START}first${HIGHLIGHT_STOP} resume.${SEARCH_PREVIEW_FRAGMENT_DELIMITER}قرار ${HIGHLIGHT_START}احمد${HIGHLIGHT_STOP}.`,
        maxLength: 1000,
        normalizedSource: "first resume. omitted middle. قرار احمد.",
        source: "First résumé. Omitted middle. قرار أَحْمَد.",
        useUnaccent: true,
      }),
    ).toBe(
      `${HIGHLIGHT_START}First${HIGHLIGHT_STOP} résumé.${SEARCH_PREVIEW_FRAGMENT_SEPARATOR}قرار ${HIGHLIGHT_START}أَحْمَد${HIGHLIGHT_STOP}.`,
    );
  });

  test("ignores zero-length highlights without mapping a negative index", () => {
    expect(
      restoreOriginalSearchPreview({
        headline: `${HIGHLIGHT_START}${HIGHLIGHT_STOP}resume approved`,
        maxLength: 1000,
        normalizedSource: "resume approved",
        source: "Résumé approved",
        useUnaccent: true,
      }),
    ).toBe("Résumé approved");
  });

  test("skips empty fragments", () => {
    expect(
      restoreOriginalSearchPreview({
        headline: `${SEARCH_PREVIEW_FRAGMENT_DELIMITER}${HIGHLIGHT_START}resume${HIGHLIGHT_STOP}${SEARCH_PREVIEW_FRAGMENT_DELIMITER}`,
        maxLength: 1000,
        normalizedSource: "resume",
        source: "Résumé",
        useUnaccent: true,
      }),
    ).toBe(`${HIGHLIGHT_START}Résumé${HIGHLIGHT_STOP}`);
  });

  test("preserves restored fragments before a later fragment stops aligning", () => {
    expect(
      restoreOriginalSearchPreview({
        headline: `${HIGHLIGHT_START}first${HIGHLIGHT_STOP}${SEARCH_PREVIEW_FRAGMENT_DELIMITER}missing`,
        maxLength: 1000,
        normalizedSource: "first. later source.",
        source: "First. Later source.",
        useUnaccent: true,
      }),
    ).toBe(`${HIGHLIGHT_START}First${HIGHLIGHT_STOP}`);
  });

  test("falls back to bounded original text when restoration cannot align", () => {
    expect(
      restoreOriginalSearchPreview({
        headline: `${HIGHLIGHT_START}missing${HIGHLIGHT_STOP}`,
        maxLength: 12,
        normalizedSource: "original source text",
        source: "Original source text",
        useUnaccent: true,
      }),
    ).toBe("Original sou");
  });

  test("truncates without emitting partial or unbalanced highlight markers", () => {
    const maxPreviewLength = HIGHLIGHT_START.length + HIGHLIGHT_STOP.length + 2;
    const restored = restoreOriginalSearchPreview({
      headline: `${HIGHLIGHT_START}resume approval follows${HIGHLIGHT_STOP}`,
      maxLength: maxPreviewLength,
      normalizedSource: "resume approval follows",
      source: "Résumé approval follows",
      useUnaccent: true,
    });

    expect(restored).toBe(`${HIGHLIGHT_START}Ré${HIGHLIGHT_STOP}`);
    for (let maxLength = 0; maxLength < restored.length; maxLength += 1) {
      const truncated = restoreOriginalSearchPreview({
        headline: `${HIGHLIGHT_START}resume approval follows${HIGHLIGHT_STOP}`,
        maxLength,
        normalizedSource: "resume approval follows",
        source: "Résumé approval follows",
        useUnaccent: true,
      });
      const withoutMarkers = truncated
        .replaceAll(HIGHLIGHT_START, "")
        .replaceAll(HIGHLIGHT_STOP, "");
      expect(truncated.length).toBeLessThanOrEqual(maxLength);
      expect(withoutMarkers).not.toContain("__HL_");
      expect(truncated.split(HIGHLIGHT_START).length).toBe(
        truncated.split(HIGHLIGHT_STOP).length,
      );
    }
  });
});
