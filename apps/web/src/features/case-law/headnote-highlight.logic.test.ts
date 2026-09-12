import { describe, expect, test } from "bun:test";

import {
  hasHighlight,
  highlightSegments,
  MIN_HIGHLIGHT_TOKEN_LENGTH,
  queryHighlightTokens,
} from "@/features/case-law/headnote-highlight.logic";

const marked = (text: string, query: string): readonly string[] =>
  highlightSegments(text, queryHighlightTokens(query))
    .filter((segment) => segment.match)
    .map((segment) => segment.text);

const joined = (text: string, query: string): string =>
  highlightSegments(text, queryHighlightTokens(query))
    .map((segment) => segment.text)
    .join("");

describe("the words of a query worth marking", () => {
  test("drops words shorter than the floor, which match too much to mean anything", () => {
    expect(queryHighlightTokens("za to je odpovědnost")).toEqual([
      "odpovědnost",
    ]);
    expect(MIN_HIGHLIGHT_TOKEN_LENGTH).toBe(3);
  });

  test("treats punctuation as a separator, so a refinement's quotes are not part of a token", () => {
    expect(queryHighlightTokens('náhrada "dobré mravy"')).toEqual([
      "náhrada",
      "dobré",
      "mravy",
    ]);
  });

  test("reports each word once", () => {
    expect(queryHighlightTokens("škoda Škoda ŠKODA")).toEqual(["škoda"]);
  });

  test("has nothing to mark for a query that is not there", () => {
    expect(queryHighlightTokens(undefined)).toEqual([]);
    expect(queryHighlightTokens("  ")).toEqual([]);
  });
});

describe("marking the query's words inside a headnote", () => {
  test("marks the word the reader asked for", () => {
    expect(
      marked("Předpokladem je odpovědnost žalovaného.", "odpovědnost"),
    ).toEqual(["odpovědnost"]);
  });

  test("marks the whole inflected word, not the prefix that matched", () => {
    expect(
      marked("Rozsah odpovědnosti za škodu.", "odpovědnost za škodu"),
    ).toEqual(["odpovědnosti", "škodu"]);
  });

  test("keeps the publisher's diacritics and casing in the marked text", () => {
    const text = "Odpovědnost Za Škodu";

    expect(marked(text, "odpovědnost škodu")).toEqual(["Odpovědnost", "Škodu"]);
    // The fixture must actually differ from the folded form, or the
    // preservation it proves is vacuous.
    expect(text.toLowerCase()).not.toBe(text);
  });

  test("does not mark the middle of an unrelated word", () => {
    // "pra" is at the floor and occurs inside "doprava"; only the word that
    // starts with it may be marked. The fixture has to carry both, or the
    // boundary rule is never reached.
    expect("doprava").toContain("pra");
    expect(marked("Doprava a pravidlo.", "pra")).toEqual(["pravidlo"]);
  });

  test("marks nothing when the query's words are absent", () => {
    const segments = highlightSegments(
      "Nájemní smlouva byla platná.",
      queryHighlightTokens("odpovědnost za škodu"),
    );

    expect(hasHighlight(segments)).toBe(false);
    expect(segments.map((segment) => segment.text).join("")).toBe(
      "Nájemní smlouva byla platná.",
    );
  });

  test("marks nothing when there is no query, so a browse row reads unmarked", () => {
    const segments = highlightSegments("Nájemní smlouva.", []);

    expect(hasHighlight(segments)).toBe(false);
    expect(segments).toEqual([
      { start: 0, text: "Nájemní smlouva.", match: false },
    ]);
  });

  test("reports each run's offset, so a renderer can key on the data", () => {
    const text = "Rozsah odpovědnosti za škodu.";
    const segments = highlightSegments(
      text,
      queryHighlightTokens("odpovědnost škodu"),
    );

    for (const segment of segments) {
      expect(
        text.slice(segment.start, segment.start + segment.text.length),
      ).toBe(segment.text);
    }
    expect(new Set(segments.map((segment) => segment.start)).size).toBe(
      segments.length,
    );
  });

  test("reproduces the text exactly, whatever it matched", () => {
    const text = "Odpovědnost, škoda; a náhrada — vše.";

    for (const query of ["odpovědnost", "škoda náhrada", "vše", "nic"]) {
      expect(joined(text, query)).toBe(text);
    }
  });
});

describe("markup in a headnote", () => {
  const text = '<script>alert("x")</script> & odpovědnost';

  test("stays text: a segment carries characters, never markup to be parsed", () => {
    const segments = highlightSegments(text, queryHighlightTokens("script"));

    expect(segments.map((segment) => segment.text).join("")).toBe(text);
    // The tag name is ordinary text to the matcher, and comes back as text.
    expect(
      segments
        .filter((segment) => segment.match)
        .map((segment) => segment.text),
    ).toEqual(["script", "script"]);
  });

  test("marking a word does not consume the angle brackets around it", () => {
    const segments = highlightSegments(
      text,
      queryHighlightTokens("odpovědnost"),
    );

    expect(segments.at(0)?.text).toBe('<script>alert("x")</script> & ');
    expect(segments.at(0)?.match).toBe(false);
  });
});
