import { describe, expect, test } from "bun:test";

import {
  CORPUS_SNIPPET_MAX_CHARS,
  highlightCorpusPassage,
  markCorpusFragment,
} from "@/api/lib/legal-search/corpus-passage-highlight";
import { tokenizeCorpusFreeText } from "@/api/lib/legal-search/corpus-query";
import { corpusTokens } from "@/api/lib/legal-search/corpus-tokens";
import csHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/cs.json";
import daHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/da.json";
import deHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/de.json";
import elHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/el.json";
import enHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/en.json";
import esHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/es.json";
import etHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/et.json";
import fiHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/fi.json";
import frHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/fr.json";
import gaHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/ga.json";
import huHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/hu.json";
import itHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/it.json";
import ltHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/lt.json";
import nlHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/nl.json";
import plHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/pl.json";
import ptHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/pt.json";
import roHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/ro.json";
import skHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/sk.json";
import svHighlightFixture from "@/api/lib/legal-search/fixtures/highlight/sv.json";
import {
  MORPHOLOGY_LANGUAGES,
  type MorphologyLanguage,
} from "@/api/lib/legal-search/morphology/stem";
import {
  searchHighlightMarks,
  stripSearchHighlightMarkup,
} from "@/api/lib/search/highlight";

/**
 * Window selection, the forms a word is matched by, the mark format, and the
 * cuts: whole words only, budget respected, empty passage empty.
 */

type HighlightFixtureCase = {
  readonly query: string;
  readonly passage: string;
};

type HighlightFixture = {
  readonly mustMark: readonly HighlightFixtureCase[];
  readonly mustNotMark: readonly HighlightFixtureCase[];
};

const HIGHLIGHT_FIXTURES = {
  cs: csHighlightFixture,
  da: daHighlightFixture,
  de: deHighlightFixture,
  el: elHighlightFixture,
  en: enHighlightFixture,
  es: esHighlightFixture,
  et: etHighlightFixture,
  fi: fiHighlightFixture,
  fr: frHighlightFixture,
  ga: gaHighlightFixture,
  hu: huHighlightFixture,
  it: itHighlightFixture,
  lt: ltHighlightFixture,
  nl: nlHighlightFixture,
  pl: plHighlightFixture,
  pt: ptHighlightFixture,
  ro: roHighlightFixture,
  sk: skHighlightFixture,
  sv: svHighlightFixture,
} as const satisfies Record<MorphologyLanguage, HighlightFixture>;

type FixtureMarksOptions = HighlightFixtureCase & {
  readonly language: MorphologyLanguage;
};

const fixtureMarks = ({ language, passage, query }: FixtureMarksOptions) =>
  searchHighlightMarks(
    markCorpusFragment({
      text: passage,
      tokens: tokenizeCorpusFreeText(query),
      language,
    }),
  );

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

const mark = (fragment: string, query: string) =>
  markCorpusFragment({
    text: fragment,
    tokens: tokenizeCorpusFreeText(query),
    language: "cs",
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

  test("marks a phrase that outruns the fragment budget", () => {
    const phrase = "dobré mravy a poctivý obchodní styk podle ustanovení";
    const passage = `Soud uvedl, že ${phrase} jsou zachovány.`;

    const { html } = highlight(passage, `"${phrase}"`, { maxChars: 20 });

    expect(searchHighlightMarks(html)).toEqual([phrase]);
  });

  test("ignores a token the index drops for length", () => {
    const oversized = "a".repeat(300);
    const passage = `${oversized} náhrada škody ${oversized}`;

    const { html, text } = highlight(passage, `${oversized} škody`);

    expect(searchHighlightMarks(html)).toEqual(["škody"]);
    expect(text).toContain("náhrada škody");
  });

  test("overlapping matches merge into one mark", () => {
    const passage = "Soud posoudil dobré mravy a dobré úmysly stran.";

    const { html } = highlight(passage, '"dobré mravy" mravy');

    expect(searchHighlightMarks(html)).toEqual(["dobré mravy"]);
  });
});

describe("stem matching", () => {
  test("marks the inflections of the query's term", () => {
    const fragment =
      "Soud přiznal náhradu škody, náhrady nákladů i náhradu újmy.";

    expect(searchHighlightMarks(mark(fragment, "náhrada"))).toEqual([
      "náhradu",
      "náhrady",
      "náhradu",
    ]);
  });

  test("marks the accented inflections of a query typed without diacritics", () => {
    const fragment = "Soud přiznal náhrady nákladů; náhrada škody trvá.";

    expect(searchHighlightMarks(mark(fragment, "nahradu"))).toEqual([
      "náhrady",
      "náhrada",
    ]);
  });

  test("leaves a word whose short stem matches only once the accents are folded", () => {
    const fragment =
      "Nájemce nemusí být v bytě přítomen; ukončení nájemního bytu se ho týká.";

    expect(searchHighlightMarks(mark(fragment, "nájemního bytu"))).toEqual([
      "bytě",
      "nájemního",
      "bytu",
    ]);
  });
});

describe("language marking fixtures", () => {
  test("cover every declared stemming language exactly once", () => {
    expect(Object.keys(HIGHLIGHT_FIXTURES).toSorted()).toEqual(
      [...MORPHOLOGY_LANGUAGES].toSorted(),
    );
  });

  for (const language of MORPHOLOGY_LANGUAGES) {
    test(`${language} applies required and excluded marks`, () => {
      const fixture = HIGHLIGHT_FIXTURES[language];
      expect(fixture.mustMark.length).toBeGreaterThan(0);
      expect(fixture.mustNotMark.length).toBeGreaterThan(0);

      for (const { passage, query } of fixture.mustMark) {
        expect(corpusTokens(query)).toEqual([query]);
        expect(corpusTokens(passage)).toEqual([passage]);
        expect(fixtureMarks({ language, passage, query })).toEqual([passage]);
      }
      for (const { passage, query } of fixture.mustNotMark) {
        expect(corpusTokens(query)).toEqual([query]);
        expect(corpusTokens(passage)).toEqual([passage]);
        expect(fixtureMarks({ language, passage, query })).toEqual([]);
      }
    });
  }
});

describe("markCorpusFragment", () => {
  test("marks every match and keeps the fragment whole, however long", () => {
    const fragment = `Smlouva & ${"slovo ".repeat(40)}náhrada škody.`;

    const html = mark(fragment, "škoda");

    expect(html).toContain("&amp;");
    expect(stripSearchHighlightMarkup(html)).toBe(fragment);
    expect(searchHighlightMarks(html)).toEqual(["škody"]);
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
