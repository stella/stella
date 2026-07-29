import { describe, expect, test } from "bun:test";

import {
  escapeAndHighlight,
  HIGHLIGHT_START,
  HIGHLIGHT_STOP,
  restoreOriginalSearchPreview,
  SEARCH_PREVIEW_FRAGMENT_DELIMITER,
  SEARCH_PREVIEW_HEADLINE_CONFIG,
} from "./highlight";

describe("search result highlighting", () => {
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
        source: "The résumé was approved.",
        useUnaccent: true,
      }),
    ).toBe(`The ${HIGHLIGHT_START}résumé${HIGHLIGHT_STOP} was approved.`);
  });

  test("restores Arabic-folded highlights with original orthography", () => {
    expect(
      restoreOriginalSearchPreview({
        headline: `قرار ${HIGHLIGHT_START}احمد${HIGHLIGHT_STOP} النهايي`,
        maxLength: 1000,
        source: "قرار أَحْمَد النهائي",
        useUnaccent: true,
      }),
    ).toBe(`قرار ${HIGHLIGHT_START}أَحْمَد${HIGHLIGHT_STOP} النهائي`);
  });

  test("restores ordered fragments and renders their paragraph separator", () => {
    expect(
      restoreOriginalSearchPreview({
        headline:
          `${HIGHLIGHT_START}first${HIGHLIGHT_STOP} resume.` +
          SEARCH_PREVIEW_FRAGMENT_DELIMITER +
          `قرار ${HIGHLIGHT_START}احمد${HIGHLIGHT_STOP}.`,
        maxLength: 1000,
        source: "First résumé. Omitted middle. قرار أَحْمَد.",
        useUnaccent: true,
      }),
    ).toBe(
      `${HIGHLIGHT_START}First${HIGHLIGHT_STOP} résumé....\n\n` +
        `قرار ${HIGHLIGHT_START}أَحْمَد${HIGHLIGHT_STOP}.`,
    );
  });

  test("falls back to bounded original text when restoration cannot align", () => {
    expect(
      restoreOriginalSearchPreview({
        headline: `${HIGHLIGHT_START}missing${HIGHLIGHT_STOP}`,
        maxLength: 12,
        source: "Original source text",
        useUnaccent: true,
      }),
    ).toBe("Original sou");
  });
});
