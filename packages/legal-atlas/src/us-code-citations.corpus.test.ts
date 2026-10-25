/**
 * The reader against real federal opinions: snippets of published opinions
 * of the Supreme Court and every court of appeals, as CourtListener's search
 * returned them for the two codes' spellings (see the fixture's provenance).
 * The golden file records what was located in each, reviewed line by line;
 * a change to the reader shows up here as the lines it changes.
 */

import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  locateUsCodeCitations,
  usCodeWorkIdentifier,
} from "./us-code-citations";

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const snippetSchema = v.object({
  opinionId: v.number(),
  court: v.string(),
  dateFiled: v.string(),
  text: v.string(),
});

const goldenSchema = v.array(
  v.object({
    opinionId: v.number(),
    citations: v.array(v.tuple([v.string(), v.string()])),
  }),
);

const snippets = new TextDecoder()
  .decode(
    Bun.gunzipSync(
      await Bun.file(
        new URL("us-code-citations.courtlistener.ndjson.gz", FIXTURES),
      ).bytes(),
    ),
  )
  .trim()
  .split("\n")
  .map((line) => v.parse(snippetSchema, JSON.parse(line)));

const golden = v.parse(
  goldenSchema,
  JSON.parse(
    await Bun.file(
      new URL("us-code-citations.courtlistener.golden.json", FIXTURES),
    ).text(),
  ),
);

const readSnippet = (text: string) =>
  locateUsCodeCitations(text).map((citation) => [
    `${usCodeWorkIdentifier(citation.work)}${citation.path
      .map((label) => `(${label})`)
      .join("")}${citation.openEnded ? " et seq." : ""}`,
    text.slice(citation.start, citation.end),
  ]);

/** Where a located span may open: a title, a Treasury or FAR rule, a listed number, a coordinated path. */
const SPAN_OPENING = /^(?:\d|Title|title|TITLE|[Ss]ection|Treas|FAR|\()/u;

describe("US code citations in federal opinions", () => {
  test("every snippet reads as the reviewed golden file records", () => {
    expect(snippets).toHaveLength(golden.length);
    for (const [index, snippet] of snippets.entries()) {
      expect({
        opinionId: snippet.opinionId,
        citations: readSnippet(snippet.text),
      }).toEqual(golden[index] ?? { opinionId: -1, citations: [] });
    }
  });

  test("the corpus covers the courts and both codes", () => {
    expect(
      new Set(snippets.map(({ court }) => court)).size,
    ).toBeGreaterThanOrEqual(14);
    const located = snippets.flatMap(({ text }) => locateUsCodeCitations(text));
    expect(
      located.filter(({ work }) => work.code === "usc").length,
    ).toBeGreaterThan(150);
    expect(
      located.filter(({ work }) => work.code === "cfr").length,
    ).toBeGreaterThan(100);
  });

  test("located spans open where a citation can, and never overlap", () => {
    for (const { text } of snippets) {
      let previousEnd = 0;
      for (const { start, end } of locateUsCodeCitations(text)) {
        expect(text.slice(start, end)).toMatch(SPAN_OPENING);
        expect(start).toBeGreaterThanOrEqual(previousEnd);
        previousEnd = end;
      }
    }
  });
});
