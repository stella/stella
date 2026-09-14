import { describe, expect, test } from "bun:test";

import { SEARCH_EXCERPTS } from "@stll/api-contract/search";

import {
  CORPUS_FRAGMENT_JOIN,
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

  // A word boundary is not a bound. A block of OCR can arrive as one enormous
  // malformed token, and the passage highlighter keeps a whole word even when
  // that overruns the budget, so without a hard cut this public endpoint would
  // return the whole block per hit.
  test.each(SEARCH_EXCERPTS.filter((length) => length !== "short"))(
    "%s never returns more than its window, whatever the passage holds",
    (excerpt) => {
      const oneHugeToken = "a".repeat(50_000);
      const widened =
        corpusExcerpt({
          engineSnippet: null,
          excerpt,
          language: null,
          passage: oneHugeToken,
          tokens,
        }) ?? "";

      expect(widened.length).toBeLessThanOrEqual(
        DECISION_EXCERPT_WINDOWS[excerpt].maxChars,
      );
    },
  );

  test("the cap never cuts a letter in half", () => {
    // Astral letters are two UTF-16 units each, so a budget that lands mid-pair
    // would otherwise return a lone surrogate.
    const astral = "\u{10348}".repeat(5000);
    const widened =
      corpusExcerpt({
        engineSnippet: null,
        excerpt: "medium",
        language: null,
        passage: astral,
        tokens,
      }) ?? "";

    expect(widened.length).toBeLessThanOrEqual(
      DECISION_EXCERPT_WINDOWS.medium.maxChars,
    );
    expect(widened).toBe(stripSearchHighlightMarkup(widened).normalize("NFC"));
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        widened,
      ),
    ).toBe(false);
  });

  // The engine answers with fragments and the handler joins several into one
  // string. That join is not a run of the passage, so anchoring on it whole
  // would never locate anything and every multi-fragment hit would quietly
  // take the unanchored path.
  test("a snippet of several fragments is anchored on one of them", () => {
    // The locatable fragment sits late in the passage, and the tokens are not
    // in the passage at all, so the unanchored path would answer with the
    // opening. Finding the late text is what proves a fragment was anchored on
    // rather than the joined string being searched for whole.
    const late = "Rozsah náhrady určuje soud podle";
    expect(PASSAGE).toContain(late);

    const widened = stripSearchHighlightMarkup(
      corpusExcerpt({
        engineSnippet: `<mark>zcela jiná věta</mark>${CORPUS_FRAGMENT_JOIN}${late}`,
        excerpt: "medium",
        language: null,
        passage: PASSAGE,
        tokens: tokenizeCorpusFreeText("bezdůvodné obohacení"),
      }) ?? "",
    );

    expect(widened).toContain(late);
    expect(PASSAGE).toContain(widened);
  });

  // Half the budget each way, except at the passage's edges: a match in the
  // opening line cannot spend a left half that is not there, and the reader
  // still asked for the whole length.
  test.each([
    ["at the start", 0],
    ["at the end", 1],
  ])("a match %s still spends the whole budget", (_label, atEnd) => {
    const anchorText =
      atEnd === 1 ? "dozvěděl o škodě." : "Soud dovodil, že náhrada";
    const widened = stripSearchHighlightMarkup(
      corpusExcerpt({
        engineSnippet: anchorText,
        excerpt: "long",
        language: null,
        passage: PASSAGE,
        tokens,
      }) ?? "",
    );

    // Within a word of the budget: the edges move to word boundaries, and the
    // passage itself is longer than the window.
    expect(widened.length).toBeGreaterThan(
      DECISION_EXCERPT_WINDOWS.long.maxChars - 30,
    );
    expect(widened.length).toBeLessThanOrEqual(
      DECISION_EXCERPT_WINDOWS.long.maxChars,
    );
  });

  // The source's own line breaks and tabs are word boundaries too; reading
  // only the space character cuts a word in half at an edge that lands on one.
  test("an edge lands on a boundary that is not a space", () => {
    const lines = [
      "Nejvyšší soud v Brně rozhodl takto:",
      "\tnáhrada škody přísluší poškozenému v plném rozsahu",
      "Odůvodnění následuje v dalším\u00a0oddíle tohoto rozhodnutí.",
    ].join("\n");
    const widened = stripSearchHighlightMarkup(
      corpusExcerpt({
        engineSnippet: "<mark>náhrada</mark> škody",
        excerpt: "medium",
        language: null,
        passage: lines,
        tokens,
      }) ?? "",
    );

    expect(lines).toContain(widened);
    // No half word at either edge: whatever the boundary character was, the
    // cut landed on it rather than inside the word beside it.
    for (const edge of [widened.slice(0, 1), widened.slice(-1)]) {
      expect(/\s/u.test(edge)).toBe(false);
    }
    const before = lines[lines.indexOf(widened) - 1];
    const after = lines[lines.indexOf(widened) + widened.length];
    for (const neighbour of [before, after]) {
      if (neighbour !== undefined) {
        expect(/\s/u.test(neighbour)).toBe(true);
      }
    }
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
