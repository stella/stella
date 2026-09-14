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
import {
  stripSearchHighlightMarkup,
  TS_HEADLINE_CONFIG,
} from "@/api/lib/search/highlight";

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
    "lhůtě, která počíná běžet ode dne, kdy se poškozený dozvěděl o škodě.";
  // A run the engine returned, marked as the engine marks it.
  const ENGINE = "<mark>náhrada</mark> škody přísluší poškozenému";
  const tokens = tokenizeCorpusFreeText("náhrada škody");
  const cut = (
    excerpt: Parameters<typeof corpusExcerpt>[0]["excerpt"],
    over: Partial<Parameters<typeof corpusExcerpt>[0]> = {},
  ) =>
    corpusExcerpt({
      engineSnippet: ENGINE,
      excerpt,
      language: null,
      passage: PASSAGE,
      tokens,
      ...over,
    }) ?? "";

  // The default page is the one every reader already sees; a cut of our own
  // there would redraw the whole corpus to fix nothing.
  test("the default is the engine's own snippet, untouched", () => {
    expect(cut("short")).toBe(ENGINE);
  });

  test("a longer length is wider and still marks the query's words", () => {
    const medium = cut("medium");
    const long = cut("long");

    expect(medium).not.toBe(ENGINE);
    expect(medium).toContain("<mark>");
    expect(long).toContain("<mark>");
    expect(long.length).toBeGreaterThan(medium.length);
  });

  // The window is the engine's account of the match with more around it, not
  // a window the client-side matcher chose for itself.
  test("the wider window is anchored on what the engine matched", () => {
    const widened = stripSearchHighlightMarkup(cut("long"));

    expect(widened).toContain(stripSearchHighlightMarkup(ENGINE));
    // Grown on both sides: the sentence the match sits in, not the text that
    // merely follows it.
    expect(widened.indexOf("náhrada škody přísluší")).toBeGreaterThan(0);
  });

  test("the window is cut on word boundaries", () => {
    const widened = stripSearchHighlightMarkup(cut("medium"));

    expect(PASSAGE).toContain(widened);
    for (const edge of [widened.slice(0, 1), widened.slice(-1)]) {
      expect(edge).not.toBe(" ");
    }
  });

  // The engine matched through stemming and expansion the client-side matcher
  // does not reproduce. Its own marks are then the only account of why the row
  // is there, and the column exists to give that account.
  test("a match the matcher cannot re-find keeps the engine's marks", () => {
    const widened = cut("long", {
      engineSnippet: "v obecné <mark>promlčecí</mark> lhůtě",
      tokens: tokenizeCorpusFreeText("promlčení"),
    });

    expect(widened).toContain("<mark>promlčecí</mark>");
    expect(widened.length).toBeGreaterThan(
      "v obecné <mark>promlčecí</mark> lhůtě".length,
    );
  });

  // The engine returns the passage's words but not always its line breaks.
  test("a snippet the engine re-wrapped is still located", () => {
    const widened = cut("medium", {
      engineSnippet: "<mark>náhrada</mark>  škody\n přísluší poškozenému",
    });

    expect(widened).toContain("<mark>");
    expect(PASSAGE).toContain(stripSearchHighlightMarkup(widened));
  });

  // The counted case: nothing to anchor on and nothing the matcher can find,
  // so the reader gets more of the passage without marks rather than being
  // dropped back to the short window they were trying to leave.
  test("a snippet absent from the passage leaves the wider window unmarked", () => {
    const widened = cut("long", {
      engineSnippet: "<mark>zcela</mark> jiná věta, která tam není",
      tokens: tokenizeCorpusFreeText("bezdůvodné obohacení"),
    });

    expect(widened).not.toContain("<mark>");
    expect(widened.length).toBeGreaterThan(0);
    expect(PASSAGE).toContain(widened);
  });

  // The fold maps folded positions back onto the passage. Walked in code
  // points rather than UTF-16 units, every offset past the first astral
  // character would address the wrong place, and the window would be cut off
  // by one unit per pair seen so far.
  test("a re-wrapped snippet is located past an astral character", () => {
    const passage =
      "\u{10348} Soud dovodil, že náhrada škody přísluší poškozenému v rozsahu, " +
      "v jakém byla škoda způsobena porušením právní povinnosti podle zákona.";
    const widened = corpusExcerpt({
      engineSnippet: "<mark>náhrada</mark>  škody\n přísluší",
      excerpt: "medium",
      language: null,
      passage,
      tokens,
    });

    expect(passage).toContain(stripSearchHighlightMarkup(widened ?? ""));
    expect(widened).toContain("<mark>");
  });

  // A reader who asked for more text is answered with the text there was,
  // never with an empty cell.
  test.each([
    ["a hit carrying no passage", undefined],
    ["a passage the index stored empty", ""],
    ["a passage of the wrong shape", 42],
  ])("falls back to the engine's snippet for %s", (_label, passage) => {
    expect(cut("long", { passage })).toBe(ENGINE);
  });
});
