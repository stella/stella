import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  escapeAndHighlight,
  HIGHLIGHT_START,
  HIGHLIGHT_STOP,
  restoreOriginalSearchPreview,
  SEARCH_PREVIEW_FRAGMENT_DELIMITER,
  SEARCH_PREVIEW_FRAGMENT_SEPARATOR,
  SEARCH_PREVIEW_HEADLINE_CONFIG,
  truncateSearchPreviewAroundCandidates,
} from "./highlight";

describe("search result highlighting", () => {
  test("centers a bounded preview around a normalized late match", () => {
    const source = `${"a".repeat(20_000)} odštěpení ${"b".repeat(20_000)}`;
    const preview = truncateSearchPreviewAroundCandidates({
      candidates: ["odstepeni"],
      maxLength: 16_000,
      source,
    });

    expect(preview).toContain("odštěpení");
    expect(preview.length).toBeLessThanOrEqual(16_000);
    expect(preview).not.toBe("a".repeat(16_000));
  });

  test("anchors locator prefixes at lexical boundaries", () => {
    const source = `educate ${"a".repeat(20_000)} catapult`;
    const preview = truncateSearchPreviewAroundCandidates({
      candidates: ["cat"],
      maxLength: 16_000,
      source,
    });

    expect(preview).toContain("catapult");
    expect(preview).not.toContain("educate");
  });

  test("maps length-changing Arabic folds back to the source", () => {
    const source = `${"a".repeat(20_000)} مـحـمـد`;
    const preview = truncateSearchPreviewAroundCandidates({
      candidates: ["محمد"],
      maxLength: 16_000,
      source,
    });

    expect(preview).toContain("مـحـمـد");
  });

  test("does not split surrogate pairs in a fallback preview", () => {
    const source = `${"a".repeat(15_999)}😀 trailing`;
    const preview = truncateSearchPreviewAroundCandidates({
      candidates: ["absent"],
      maxLength: 16_000,
      source,
    });

    expect(preview).toBe("a".repeat(15_999));
    expect(preview).not.toContain("\u{d83d}");
  });

  test("centers on an intact phrase instead of an earlier standalone word", () => {
    const source = `closing ${"a".repeat(20_000)} closing, memo`;
    const preview = truncateSearchPreviewAroundCandidates({
      candidates: ["closing memo"],
      maxLength: 16_000,
      source,
    });

    expect(preview).toContain("closing, memo");
    expect(preview).not.toStartWith("closing ");
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

describe("preview literal selection", () => {
  test("bounds restoration work for repetitive sources and overlapping fragments", () => {
    const source = "a".repeat(50_000);
    const fragments = Array.from({ length: 64 }, (_, index) =>
      "a".repeat(index + 1),
    );
    const started = performance.now();
    const restored = restoreOriginalSearchPreview({
      source,
      normalizedSource: source,
      headline: fragments.join(SEARCH_PREVIEW_FRAGMENT_DELIMITER),
      maxLength: 10_000,
      useUnaccent: false,
    });
    const elapsedMs = performance.now() - started;

    expect(restored).toBe(fragments.join(SEARCH_PREVIEW_FRAGMENT_SEPARATOR));
    // Source alignment is linear; enumerating every overlapping occurrence
    // instead creates more than three million unnecessary match records.
    expect(elapsedMs).toBeLessThan(1000);
  });

  test("preserves first-listed candidate priority at a tied lexeme start", () => {
    const source = "00000 catapultmmm tail";
    expect(
      truncateSearchPreviewAroundCandidates({
        source,
        candidates: ["cat", "catapult"],
        maxLength: 8,
      }),
    ).toBe("00 catap");
    expect(
      truncateSearchPreviewAroundCandidates({
        source,
        candidates: ["catapult", "cat"],
        maxLength: 8,
      }),
    ).toBe("catapult");
  });
  test("uses consecutive lexical prefixes across punctuation and folded Czech inflections", () => {
    const source = "aaaaa JUDr. Novákové, návrhu... konec";
    expect(
      truncateSearchPreviewAroundCandidates({
        source,
        candidates: ["Novak navr"],
        maxLength: 18,
      }),
    ).toContain("Novákové, návrhu");
    expect(
      truncateSearchPreviewAroundCandidates({
        source,
        candidates: ["Novak konec"],
        maxLength: 8,
      }),
    ).toBe("aaaaa JU");
    expect(
      truncateSearchPreviewAroundCandidates({
        source,
        candidates: ["...", ""],
        maxLength: 8,
      }),
    ).toBe("aaaaa JU");
  });
  test("restores overlapping literal fragment sets at a monotonic cursor", () => {
    const restored = restoreOriginalSearchPreview({
      source: "aaaaa",
      normalizedSource: "aaaaa",
      headline: `aa${SEARCH_PREVIEW_FRAGMENT_DELIMITER}aaa`,
      maxLength: 100,
      useUnaccent: false,
    });
    expect(restored).toBe(`aa${SEARCH_PREVIEW_FRAGMENT_SEPARATOR}aaa`);
    expect(
      restoreOriginalSearchPreview({
        source: "a.b axb a.b",
        normalizedSource: "a.b axb a.b",
        headline: `a.b${SEARCH_PREVIEW_FRAGMENT_DELIMITER}a.b`,
        maxLength: 100,
        useUnaccent: false,
      }),
    ).toBe(`a.b${SEARCH_PREVIEW_FRAGMENT_SEPARATOR}a.b`);
  });
});

test("headline fragments agree with a monotonic exact-substring oracle", () => {
  assertProperty(
    "headline fragments agree with a monotonic exact-substring oracle",
    fc.property(
      fc.array(fc.constantFrom("a", "b", "ě", "😀", "a.b"), { maxLength: 30 }),
      fc.array(fc.constantFrom("a", "aa", "ě", "😀", "a.b", "missing", ""), {
        maxLength: 8,
      }),
      (units, fragments) => {
        const source = units.join(" ");
        const restored: string[] = [];
        let cursor = 0;
        for (const fragment of fragments) {
          if (fragment.length === 0) {
            continue;
          }
          const start = source.indexOf(fragment, cursor);
          if (start === -1) {
            break;
          }
          restored.push(source.slice(start, start + fragment.length));
          cursor = start + fragment.length;
        }
        expect(
          restoreOriginalSearchPreview({
            source,
            normalizedSource: source,
            headline: fragments.join(SEARCH_PREVIEW_FRAGMENT_DELIMITER),
            maxLength: 10_000,
            useUnaccent: false,
          }),
        ).toBe(
          restored.length > 0
            ? restored.join(SEARCH_PREVIEW_FRAGMENT_SEPARATOR)
            : source,
        );
      },
    ),
  );
});

test("preview matching uses scalar boundaries and normalized UTF-16 source offsets", () => {
  expect(
    truncateSearchPreviewAroundCandidates({
      source: "x\ud800y",
      candidates: [],
      maxLength: 10,
    }),
  ).toBe("x�y");
  expect(
    restoreOriginalSearchPreview({
      source: "x\ud801y",
      normalizedSource: "x\ud801y",
      headline: "\ud800",
      maxLength: 100,
      useUnaccent: false,
    }),
  ).toBe("�");
  expect(
    restoreOriginalSearchPreview({
      source: "😀",
      normalizedSource: "😀",
      headline: "\ud83d",
      maxLength: 100,
      useUnaccent: false,
    }),
  ).toBe("😀");
});

test("preview lexical prefixes agree with the ordered token-prefix oracle", () => {
  assertProperty(
    "preview lexical prefixes agree with the ordered token-prefix oracle",
    fc.property(
      fc.array(fc.constantFrom("aa", "ab", "bb", "ba", "catapult", "memo"), {
        maxLength: 20,
      }),
      fc.array(
        fc.constantFrom("a", "b", "aa b", "cat", "catapult", "memo", "...", ""),
        { maxLength: 8 },
      ),
      (words, candidates) => {
        const source = `00000 ${words.join(", ")} 99999`;
        const lexemes = Array.from(source.matchAll(/[a-z0-9]+/gu));
        let firstStart = Infinity;
        let firstLength = 0;
        for (const candidate of candidates) {
          const prefixes = Array.from(
            candidate.matchAll(/[a-z0-9]+/gu),
            (match) => match[0],
          );
          if (prefixes.length === 0) {
            continue;
          }
          for (
            let index = 0;
            index <= lexemes.length - prefixes.length;
            index += 1
          ) {
            if (
              !prefixes.every((prefix, offset) =>
                lexemes.at(index + offset)?.[0].startsWith(prefix),
              )
            ) {
              continue;
            }
            const first = lexemes.at(index);
            const last = lexemes.at(index + prefixes.length - 1);
            const finalPrefix = prefixes.at(-1);
            if (
              first === undefined ||
              last === undefined ||
              finalPrefix === undefined
            ) {
              throw new TypeError("Oracle lexeme range is incomplete");
            }
            if (first.index < firstStart) {
              firstStart = first.index;
              firstLength = last.index + finalPrefix.length - first.index;
            }
            break;
          }
        }
        const center = Math.floor(firstStart + firstLength / 2);
        const start = Number.isFinite(firstStart)
          ? Math.max(0, Math.min(source.length - 8, center - 4))
          : 0;
        expect(
          truncateSearchPreviewAroundCandidates({
            source,
            candidates,
            maxLength: 8,
          }),
        ).toBe(source.slice(start, start + 8));
      },
    ),
  );
});
