import { describe, expect, test } from "bun:test";

import { SEARCH_EXCERPTS } from "@stll/api-contract/search";

import {
  corpusExcerpt,
  DECISION_EXCERPT_WINDOWS,
  decisionExcerptWindow,
  decisionHeadlineConfig,
  usesEngineSnippet,
} from "@/api/lib/case-law/decision-excerpt";
import { tokenizeCorpusFreeText } from "@/api/lib/legal-search/corpus-query";
import { TS_HEADLINE_CONFIG } from "@/api/lib/search/highlight";

describe("how much of a passage each excerpt length shows", () => {
  // The reader asked for a longer excerpt, so every step has to actually be
  // longer. Asserted across the whole union rather than pair by pair, so a
  // fourth length cannot be added out of order.
  test("each length is wider than the one before it", () => {
    const windows = SEARCH_EXCERPTS.map((excerpt) =>
      decisionExcerptWindow(excerpt),
    );

    for (const [index, window] of windows.entries()) {
      const previous = windows[index - 1];
      if (previous === undefined) {
        continue;
      }
      expect(window.maxChars).toBeGreaterThan(previous.maxChars);
      expect(window.maxWords).toBeGreaterThan(previous.maxWords);
      expect(window.minWords).toBeGreaterThan(previous.minWords);
    }
  });

  // A floor above its own ceiling would ask Postgres for a fragment it cannot
  // cut, and the engine would answer with something other than what was asked.
  test("no length asks for a floor above its own ceiling", () => {
    for (const excerpt of SEARCH_EXCERPTS) {
      const { maxWords, minWords } = decisionExcerptWindow(excerpt);
      expect(minWords).toBeLessThan(maxWords);
    }
  });

  // The default is not a redesign of every result page that exists: it has to
  // be the window the search already produced, on both engines.
  test("the default reproduces the window results are drawn at today", () => {
    expect(decisionHeadlineConfig("short")).toBe(TS_HEADLINE_CONFIG);
    expect(usesEngineSnippet("short")).toBe(true);
  });

  // Quickwit carries no size on the wire, so a wider excerpt is only reachable
  // by cutting the passage ourselves; a length that still deferred to the
  // engine would silently show the short window.
  test("every length beyond the default is cut rather than asked for", () => {
    for (const excerpt of SEARCH_EXCERPTS.filter(
      (candidate) => candidate !== "short",
    )) {
      expect(usesEngineSnippet(excerpt)).toBe(false);
    }
  });

  test("the longest excerpt stays inside one indexed passage", () => {
    // The chunker targets roughly 400 tokens, and `CHARS_PER_TOKEN` there is
    // 4, so a passage runs to about 1600 characters. An excerpt wider than
    // that could not be cut from the passage the hit carries.
    const PASSAGE_CHARS = 1600;

    expect(DECISION_EXCERPT_WINDOWS.long.maxChars).toBeLessThan(PASSAGE_CHARS);
  });
});

describe("the excerpt a corpus hit shows", () => {
  // Longer than the widest window, or `medium` and `long` would both return
  // the whole passage and the test could not tell them apart.
  const PASSAGE =
    "Soud dovodil, že náhrada škody přísluší poškozenému v rozsahu, v jakém " +
    "byla škoda způsobena porušením právní povinnosti, a to i tehdy, byla-li " +
    "povinnost porušena z nedbalosti. Rozsah náhrady určuje soud podle " +
    "okolností případu, přičemž přihlíží k míře zavinění na straně škůdce i " +
    "poškozeného. Nárok na náhradu škody se promlčuje v obecné promlčecí " +
    "lhůtě, která počíná běžet ode dne, kdy se poškozený dozvěděl o škodě a " +
    "o tom, kdo za ni odpovídá.";
  const ENGINE = "<mark>náhrada</mark> škody přísluší";
  const cut = (excerpt: Parameters<typeof corpusExcerpt>[0]["excerpt"]) =>
    corpusExcerpt({
      engineSnippet: ENGINE,
      excerpt,
      language: null,
      passage: PASSAGE,
      tokens: tokenizeCorpusFreeText("náhrada škody"),
    });

  // The default page is the one every reader already sees; a cut of our own
  // there would redraw the whole corpus to fix nothing.
  test("the default is the engine's own snippet, untouched", () => {
    expect(cut("short")).toBe(ENGINE);
  });

  test("a longer length is cut wider and still marks the query's words", () => {
    const medium = cut("medium") ?? "";
    const long = cut("long") ?? "";

    expect(medium).not.toBe(ENGINE);
    expect(medium).toContain("<mark>");
    expect(long).toContain("<mark>");
    expect(long.length).toBeGreaterThan(medium.length);
  });

  // A reader who asked for more text is answered with the text there was,
  // never with an empty cell.
  test.each([
    ["a hit carrying no passage", undefined],
    ["a passage the index stored empty", ""],
    ["a passage of the wrong shape", 42],
  ])("falls back to the engine's snippet for %s", (_label, passage) => {
    expect(
      corpusExcerpt({
        engineSnippet: ENGINE,
        excerpt: "long",
        language: null,
        passage,
        tokens: tokenizeCorpusFreeText("náhrada škody"),
      }),
    ).toBe(ENGINE);
  });

  // The engine matched this passage through stemming and expansion, which the
  // cutter does not reproduce, so it can fail to locate the words here. The
  // passage is still the one that matched: the reader asked for more of it and
  // gets more of it, unmarked, rather than being dropped back to the short
  // window they were trying to leave.
  test("a passage whose words cannot be located is still widened", () => {
    const widened =
      corpusExcerpt({
        engineSnippet: ENGINE,
        excerpt: "long",
        language: null,
        passage: PASSAGE,
        tokens: tokenizeCorpusFreeText("promlčení"),
      }) ?? "";

    expect(widened).not.toBe(ENGINE);
    expect(widened.length).toBeGreaterThan(ENGINE.length);
  });
});
