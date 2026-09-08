import { describe, expect, test } from "bun:test";

import {
  CORPUS_SNIPPET_MAX_CHARS,
  highlightCorpusPassage,
} from "@/api/lib/legal-search/corpus-passage-highlight";
import { tokenizeCorpusFreeText } from "@/api/lib/legal-search/corpus-query";
import { corpusTokens } from "@/api/lib/legal-search/corpus-tokens";
import { searchHighlightMarks } from "@/api/lib/search/highlight";

/**
 * Window selection, the forms a passage word is matched by, the mark format,
 * and the cuts: whole words only, budget respected, empty passage empty.
 */

const highlight = (
  passage: string,
  query: string,
  options: { language?: "cs" | null; maxChars?: number } = {},
) =>
  highlightCorpusPassage({
    passage,
    tokens: tokenizeCorpusFreeText(query),
    language: options.language === undefined ? "cs" : options.language,
    maxChars: options.maxChars,
  });

describe("window selection", () => {
  test("prefers the window holding more distinct query terms", () => {
    const filler = "text ".repeat(30);
    const passage = `alpha alpha alpha ${filler} alpha beta ${filler} end`;

    const { text } = highlight(passage, "alpha beta", { maxChars: 40 });

    expect(text).toContain("alpha beta");
  });

  test("prefers more matches when the distinct-term count ties", () => {
    const filler = "slovo ".repeat(30);
    const passage = `alpha ${filler} alpha alpha alpha ${filler} konec`;

    const { text } = highlight(passage, "alpha", { maxChars: 40 });

    expect(corpusTokens(text).filter((word) => word === "alpha")).toHaveLength(
      3,
    );
  });

  test("takes the earliest window when nothing else separates them", () => {
    const filler = "slovo ".repeat(30);
    const passage = `alpha ${filler} alpha`;

    const { text } = highlight(passage, "alpha", { maxChars: 40 });

    expect(passage.indexOf(text)).toBe(0);
  });

  test("a passage with no match yields its leading fragment", () => {
    const passage = "první věta rozhodnutí. ".repeat(20);

    const { html, text } = highlight(passage, "nesouvisející");

    expect(passage.startsWith(text)).toBe(true);
    expect(html).not.toContain("<mark>");
    expect(text.length).toBeLessThanOrEqual(CORPUS_SNIPPET_MAX_CHARS);
  });

  test("an empty passage yields an empty fragment", () => {
    expect(highlight("", "cokoliv")).toEqual({ html: "", text: "" });
    expect(highlight("   \n\n  ", "cokoliv")).toEqual({ html: "", text: "" });
  });
});

describe("matching", () => {
  test("matches a Czech inflection through the stem the index holds", () => {
    const passage =
      "Soud posoudil ukončení nájemního vztahu k bytu podle občanského zákoníku.";

    const { html } = highlight(passage, "nájemní");

    expect(searchHighlightMarks(html)).toEqual(["nájemního"]);
  });

  test("matches text written with diacritics from a query written without", () => {
    const passage = "Nárok na náhradu škody soud zamítl.";

    const { html } = highlight(passage, "skody");

    expect(searchHighlightMarks(html)).toEqual(["škody"]);
  });

  test("marks a phrase only where its words are adjacent", () => {
    const passage =
      "Jednání proti dobrým mravům je neplatné; dobrým úmyslem to nebylo, mravům navzdory.";

    const { html } = highlight(passage, '"dobrým mravům"');

    expect(searchHighlightMarks(html)).toEqual(["dobrým mravům"]);
  });

  test("a language without stemming still matches surface forms", () => {
    const passage = "The court dismissed the claim for damages.";

    const { html } = highlight(passage, "damages", { language: null });

    expect(searchHighlightMarks(html)).toEqual(["damages"]);
  });

  test("overlapping matches merge into one mark", () => {
    const passage = "Soud posoudil dobré mravy a dobré úmysly stran.";

    const { html } = highlight(passage, '"dobré mravy" mravy');

    expect(searchHighlightMarks(html)).toEqual(["dobré mravy"]);
  });
});

describe("format", () => {
  test("escapes the passage and marks in the form the browser renders", () => {
    const passage = 'Smlouva & "podmínky" <b>alpha</b> uzavřená stranami.';

    const { html } = highlight(passage, "alpha");

    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;podmínky&quot;");
    expect(html).toContain("&lt;b&gt;<mark>alpha</mark>&lt;/b&gt;");
  });

  test("cuts on word boundaries, never inside a word", () => {
    const passage =
      "Nejvyšší soud posoudil neplatnost výpovědi z nájmu bytu podle ustanovení občanského zákoníku a rozhodnutí odvolacího soudu zrušil.";

    const { text } = highlight(passage, "výpovědi", { maxChars: 60 });

    const start = passage.indexOf(text);
    expect(start).toBeGreaterThanOrEqual(0);
    const before = passage.slice(0, start);
    const after = passage.slice(start + text.length);
    expect(before === "" || /\W$/u.test(before)).toBe(true);
    expect(after === "" || /^\W/u.test(after)).toBe(true);
  });

  test("keeps the fragment inside the character budget", () => {
    const passage = "slovo ".repeat(200);

    const { text } = highlight(passage, "slovo", { maxChars: 50 });

    expect(text.length).toBeLessThanOrEqual(50);
  });

  test("a single word longer than the budget is still a fragment", () => {
    const oversized = "a".repeat(200);

    const { text } = highlight(oversized, "cokoliv", { maxChars: 50 });

    expect(text).toBe(oversized);
  });
});
