/**
 * CJEU parser tests.
 *
 * The parser reads the class-annotated XHTML Cellar serves, but Cellar
 * also publishes the same decision as Formex XML, which states the
 * structure outright: `GR.SEQ LEVEL` for heading depth, `NP.ECR/NO.P`
 * for paragraph numbers, `INDEX/KEYWORD` for the keyword chain. That
 * makes the publisher, rather than a hand-written expectation, the
 * authority on whether the parser read a document correctly — which is
 * what a language-independent parser needs, since nobody reviewing this
 * repo reads all 24 official languages.
 *
 * Fixtures are recorded by `scripts/record-eu-ecj-fixtures.ts` and
 * gzipped; see that script for why each document is in the corpus.
 *
 * Each fixture is asserted in one test so its XHTML, AST and Formex
 * tree are collectable as soon as that document is done. These are the
 * largest documents in the repo's fixtures and a per-assertion split
 * held all of them at once, against the suite's peak-RSS budget.
 */

import { Glob } from "bun";
import { describe, expect, test } from "bun:test";

import { parseEcjDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/eu-ecj";
import {
  normalizeOracleText,
  parseFormex,
} from "@/api/handlers/case-law/ingestion/parsers/eu-ecj-formex";
import { sectionsFromAst } from "@/api/handlers/case-law/ingestion/sections-from-ast";

const FIXTURES_DIR = new URL("__fixtures__/eu-ecj/", import.meta.url);
const decoder = new TextDecoder();

const readFixture = async (name: string): Promise<string | undefined> => {
  const file = Bun.file(new URL(name, FIXTURES_DIR));
  if (!(await file.exists())) {
    return undefined;
  }
  return decoder.decode(Bun.gunzipSync(await file.bytes()));
};

const fixtureStems = await Array.fromAsync(
  new Glob("*.html.gz").scan(FIXTURES_DIR.pathname),
).then((names) => names.map((name) => name.replace(/\.html\.gz$/u, "")).sort());

if (fixtureStems.length === 0) {
  throw new Error(
    "No eu-ecj parser fixtures found; run scripts/record-eu-ecj-fixtures.ts",
  );
}

describe("parseEcjDecisionHtml", () => {
  test.each(fixtureStems)("%s", async (stem) => {
    const [celex = "", language = ""] = stem.split(".");
    const html = await readFixture(`${stem}.html.gz`);
    if (html === undefined) {
      throw new Error(`Missing fixture for ${stem}`);
    }

    const parsed = parseEcjDecisionHtml({
      caseNumber: celex,
      ecli: undefined,
      court: "Court of Justice",
      decisionDate: undefined,
      decisionType: undefined,
      sourceUrl: undefined,
      celex,
      html,
    });
    const blocks = parsed.documentAst.blocks;

    // ── Completeness ─────────────────────────────────────────
    // Text that never reaches the AST is invisible in the reader and
    // to the AI pipeline, and nothing downstream can tell it is gone.
    // These assertions come first because they are the ones that must
    // never be relaxed to make a parser change land.

    // The pre-parser state of this adapter was an empty AST for every
    // ECJ decision, in every language. That must now be a failure, not
    // the accepted default.
    expect(blocks.length).toBeGreaterThan(0);
    expect(parsed.fulltext.length).toBeGreaterThan(1000);
    // CONTENT_LOSS and MISSING_WORDS from the shared validator are the
    // real completeness guard: they compare the AST's words against the
    // source document's, so text dropped anywhere shows up here.
    expect(parsed.validationIssues).toEqual([]);

    // ── Fidelity ─────────────────────────────────────────────
    // Structure the parser recovered on top of that text. Wrong shape
    // is a bad reading experience, not a wrong answer, so this is the
    // part allowed a known tail on documents outside the corpus.

    // Paragraph numbers are structure, not text: 1..n, no gaps, and
    // anchored on the publisher's own `pointN` ids so deep links match
    // the fragments EUR-Lex and the Court's cross-references use.
    const numbered = blocks.flatMap((block) =>
      block.type === "paragraph" && block.number !== undefined ? [block] : [],
    );
    expect(numbered.map((block) => block.number)).toEqual(
      Array.from({ length: numbered.length }, (_, i) => i + 1),
    );
    expect(numbered.map((block) => block.anchorId)).toEqual(
      numbered.map((block) => `point${block.number}`),
    );
    expect(new Set(blocks.map((block) => block.anchorId)).size).toBe(
      blocks.length,
    );

    // Sections give the reader's structure margin something to show.
    const sections = sectionsFromAst(blocks);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.map((section) => section.index)).toEqual(
      sections.map((_, index) => index),
    );
    expect(sections.slice(1).every((section) => section.title !== null)).toBe(
      true,
    );

    const formex = await readFixture(`${stem}.fmx.xml.gz`);
    if (formex === undefined) {
      return;
    }

    // Everything above is completeness and applies to every layout.
    // What follows compares structure against Formex, and only the
    // layouts that publish structure can be held to it: the oldest one
    // prints paragraph numbers as ordinary text, names its sections
    // with `<h2>` where Formex declares more, and omits the keyword
    // chain from the rendering entirely. Recovering those would mean
    // guessing at text, so the parser does not, and neither does this.
    // Its `pointN` anchors are the marker for the layouts that do.
    if (!html.includes('id="point')) {
      expect(parsed.keywords).toEqual([]);
      expect(numbered).toHaveLength(0);
      return;
    }

    const oracle = parseFormex(formex);

    expect(parsed.keywords).toEqual(oracle.keywords);
    expect(numbered.map((block) => block.number)).toEqual(
      oracle.paragraphNumbers,
    );

    // Formex declares the document's own section tree. Every entry must
    // appear as a heading, in order and at the same depth. The parser
    // may hold headings Formex models elsewhere (an opinion's "Table of
    // contents" line), so this is containment, not equality.
    const headings = blocks.flatMap((block) =>
      block.type === "heading" && block.role === "section-heading"
        ? [{ level: block.level, text: normalizeOracleText(block.plainText) }]
        : [],
    );
    let cursor = 0;
    for (const expected of oracle.headings) {
      const at = headings.findIndex(
        // eslint-disable-next-line no-loop-func -- `cursor` is the walk's position; the closure reads it on the same iteration it is set
        (heading, index) => index >= cursor && heading.text === expected.text,
      );
      expect({ language, heading: expected.text, found: at !== -1 }).toEqual({
        language,
        heading: expected.text,
        found: true,
      });
      expect(headings[at]).toEqual(expected);
      cursor = at + 1;
    }

    const holdings = blocks
      .filter((block) => block.type === "paragraph" && block.role === "holding")
      .map((block) => normalizeOracleText(block.plainText));
    for (const item of oracle.operativeItems) {
      expect(holdings.some((holding) => holding.includes(item))).toBe(true);
    }

    expect(
      blocks.some(
        (block) => block.type === "paragraph" && block.role === "signature",
      ),
    ).toBe(oracle.hasSignature);
  });

  test("keeps every document kind in the corpus", async () => {
    const kinds = new Set<string>();
    for (const stem of fixtureStems) {
      // oxlint-disable-next-line no-await-in-loop -- one fixture read per corpus entry, released before the next
      const formex = await readFixture(`${stem}.fmx.xml.gz`);
      if (formex !== undefined) {
        kinds.add(parseFormex(formex).kind);
      }
    }

    // Dropping a document kind from the corpus would silently narrow
    // every assertion above, so the corpus itself is asserted.
    expect([...kinds].sort()).toEqual(["CONCLUSION", "JUDGMENT", "ORDER"]);
  });

  test("keeps both converter spellings in the corpus", async () => {
    const spellings = new Set<string>();
    for (const stem of fixtureStems) {
      // oxlint-disable-next-line no-await-in-loop -- one fixture read per corpus entry, released before the next
      const html = await readFixture(`${stem}.html.gz`);
      if (html === undefined) {
        continue;
      }
      spellings.add(
        html.includes('class="coj-normal"') ? "coj-prefixed" : "unprefixed",
      );
    }

    // Documents converted before the Publications Office's version 9
    // pipeline spell the class vocabulary without the `coj-` prefix.
    // They are most of the pre-2019 corpus, and they parsed to a
    // structureless wall of text until the parser accepted both.
    expect([...spellings].sort()).toEqual(["coj-prefixed", "unprefixed"]);
  });

  test("reads the keyword chain in a non-Latin script", async () => {
    const html = await readFixture("62022CJ0128.el.html.gz");
    if (html === undefined) {
      throw new Error("Missing Greek fixture");
    }
    const { keywords } = parseEcjDecisionHtml({
      caseNumber: "C-128/22",
      ecli: undefined,
      court: "Court of Justice",
      decisionDate: undefined,
      decisionType: undefined,
      sourceUrl: undefined,
      celex: "62022CJ0128",
      html,
    });

    expect(keywords.length).toBeGreaterThan(10);
    // Guillemets open and close the Greek chain; they are delimiters,
    // not part of the first and last keyword.
    expect(keywords.at(0)?.startsWith("«")).toBe(false);
    expect(keywords.at(-1)?.endsWith("»")).toBe(false);
  });
});
