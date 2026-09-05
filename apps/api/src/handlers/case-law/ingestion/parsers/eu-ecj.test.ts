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
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import * as cheerio from "cheerio";

import {
  hasBlockInlines,
  hasInlineChildren,
} from "@/api/handlers/case-law/document-ast";
import type { Block, Inline } from "@/api/handlers/case-law/document-ast";
import {
  ecjDocumentHtml,
  ecjDocumentRoot,
  ecjPageCarriesChrome,
  parseEcjDecisionHtml,
} from "@/api/handlers/case-law/ingestion/parsers/eu-ecj";
import {
  normalizeOracleText,
  parseFormex,
} from "@/api/handlers/case-law/ingestion/parsers/eu-ecj-formex";
import { sectionsFromAst } from "@/api/handlers/case-law/ingestion/sections-from-ast";

import {
  PORTAL_CORPUS,
  PORTAL_DOCUMENT_CONTAINER,
  PORTAL_STEM_SUFFIX,
  type PortalPair,
  SHELL_STEM,
  SHELL_STEM_SUFFIX,
  manifestationStem,
  portalStem,
} from "./__fixtures__/eu-ecj/corpus";

/**
 * Every test here gunzips and parses one of the largest fixtures in the repo,
 * twice — once as XHTML and once as Formex — which runs for seconds, close
 * enough to the 5s default that these fail on a loaded machine rather than on
 * a defect. Stated once for the file because the cost is the file's, not one
 * test's; a real hang still ends the run well inside the runner's own
 * deadline.
 */
setDefaultTimeout(30_000);

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

/**
 * Recordings that hold a decision. A shell recording holds none, so
 * every completeness and fidelity assertion below would be false of it.
 */
const decisionStems = fixtureStems.filter(
  (stem) => !stem.endsWith(SHELL_STEM_SUFFIX),
);

/** Replace every link inline with the text it carries. */
const flattenLinks = (inlines: readonly Inline[]): Inline[] =>
  inlines.flatMap((node): Inline[] => {
    if (node.type === "link") {
      return flattenLinks(node.children);
    }
    if (!hasInlineChildren(node)) {
      return [node];
    }
    return [{ ...node, children: flattenLinks(node.children) }];
  });

/**
 * Join runs of text inlines into one, so that text arrived at by
 * flattening a link compares equal to text the walk never split.
 */
const mergeAdjacentText = (inlines: readonly Inline[]): Inline[] => {
  const merged: Inline[] = [];
  for (const node of inlines) {
    const previous = merged.at(-1);
    if (
      node.type === "text" &&
      previous?.type === "text" &&
      previous.anonymized === node.anonymized
    ) {
      merged[merged.length - 1] = {
        ...previous,
        text: previous.text + node.text,
      };
      continue;
    }
    merged.push(
      hasInlineChildren(node)
        ? { ...node, children: mergeAdjacentText(node.children) }
        : node,
    );
  }
  return merged;
};

/**
 * Blocks with cross-reference targets dropped, their text kept.
 *
 * The publisher addresses the same cross-references differently in its
 * two encodings: a manifestation links them by absolute Cellar ECLI
 * URL, a portal page by a path relative to itself, which means nothing
 * once the decision is stored and so is flattened to text. That is the
 * publisher's difference, and it is the only one a comparison between
 * the two encodings may tolerate.
 */
const withoutLinkTargets = (blocks: readonly Block[]): Block[] =>
  blocks.map((block) =>
    hasBlockInlines(block)
      ? { ...block, inlines: mergeAdjacentText(flattenLinks(block.inlines)) }
      : block,
  );

const countLinks = (inlines: readonly Inline[]): number => {
  let total = 0;
  for (const node of inlines) {
    if (node.type === "text" || node.type === "line-break") {
      continue;
    }
    if (node.type === "link") {
      total += 1;
    }
    if (hasInlineChildren(node)) {
      total += countLinks(node.children);
    }
  }
  return total;
};

const countBlockLinks = (blocks: readonly Block[]): number => {
  let total = 0;
  for (const block of blocks) {
    if (hasBlockInlines(block)) {
      total += countLinks(block.inlines);
    }
  }
  return total;
};

describe("parseEcjDecisionHtml", () => {
  test.each(decisionStems)("%s", async (stem) => {
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
    // Every recording of a real decision is bounded by the converter's own
    // markers, in every layout the corpus holds — the prefixed vocabulary,
    // the unprefixed one, and the oldest layout's bare wrapper. The adapter
    // reads the fallback boundary as "this response is not a decision", so
    // this is what says no published document can take that path.
    expect(parsed.boundary).toBe("converter");
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
    // Sections are cut at the document's own level-1 headings, and at
    // the operative part, which courts introduce with a sentence
    // rather than a heading. So a section is titled unless it is one
    // of those unheaded runs.
    expect(
      sections.filter((section) => section.title !== null).length,
    ).toBeGreaterThan(1);

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
    for (const stem of decisionStems) {
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
    for (const stem of decisionStems) {
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

  /**
   * The publisher serves the same converter output twice: on its own,
   * and embedded in a portal page that adds navigation, inline scripts,
   * a contact block and a footer around it. Those are the site's, not
   * the Court's, so the parse must be the same either way.
   *
   * Driven off `PORTAL_CORPUS`, the same list the recorder writes from,
   * so a declared pair cannot be recorded without being compared.
   */
  test.each(
    PORTAL_CORPUS.map((pair) => [manifestationStem(pair), pair] as const),
  )(
    "reads only the decision out of the page carrying it: %s",
    async (_stem: string, pair: PortalPair) => {
      const decision = await readFixture(`${manifestationStem(pair)}.html.gz`);
      const page = await readFixture(`${portalStem(pair)}.html.gz`);
      if (decision === undefined || page === undefined) {
        throw new Error(
          `Missing the ${manifestationStem(pair)} pair; run scripts/record-eu-ecj-fixtures.ts`,
        );
      }

      // Both halves are the publisher's own output for one decision, and
      // the page is mostly not the decision. Without that the comparison
      // below would hold over nothing.
      expect(page).toContain(PORTAL_DOCUMENT_CONTAINER);
      expect(decision).not.toContain(PORTAL_DOCUMENT_CONTAINER);
      expect(page.length).toBeGreaterThan(decision.length * 1.5);

      const parsePair = (html: string) =>
        parseEcjDecisionHtml({
          caseNumber: pair.celex,
          ecli: undefined,
          court: "Court of Justice",
          decisionDate: undefined,
          decisionType: undefined,
          sourceUrl: undefined,
          language: pair.language.toLowerCase(),
          celex: pair.celex,
          html,
        });

      const parsedDecision = parsePair(decision);
      const parsedPage = parsePair(page);

      // One equality carries both halves of the guarantee: nothing the
      // page adds may reach the AST, and nothing the decision holds may
      // be lost on the way. Stating it this way also keeps the parser
      // honest, since no list of things to ignore can satisfy it — and a
      // list would only ever be right in the language it was written in.
      //
      // Whole blocks rather than their text: type, role, heading level,
      // paragraph number, anchor and inline structure all decide how a
      // decision renders and cites, and every one of them can change
      // while the text stays identical. Block ids and anchors are
      // counter-derived, so two parses of one decision produce the same
      // ones. The right-hand side is oracle-checked against Formex above.
      expect(withoutLinkTargets(parsedPage.documentAst.blocks)).toEqual(
        withoutLinkTargets(parsedDecision.documentAst.blocks),
      );
      // The one tolerated difference has to be doing real work, or the
      // comparison above would be equally true of two link-free ASTs.
      expect(
        countBlockLinks(parsedDecision.documentAst.blocks),
      ).toBeGreaterThan(0);
      expect(parsedPage.fulltext).toEqual(parsedDecision.fulltext);
      expect(parsedPage.keywords).toEqual(parsedDecision.keywords);

      // Completeness is measured against the decision, not the page. An
      // issue here would read as a lost-content parse and send a correct
      // AST down the caller's fallback, which stores the page's text.
      expect(parsedPage.validationIssues).toEqual([]);

      // That fallback takes the same boundary without parsing, so it
      // cannot store the page either.
      const bounded = ecjDocumentHtml(page);
      expect(bounded.boundary).toBe("converter");
      expect(bounded.html).not.toContain(PORTAL_DOCUMENT_CONTAINER);
      expect(parsePair(bounded.html).fulltext).toEqual(parsedDecision.fulltext);

      // A decision served on its own is already the whole document, so
      // bounding must leave it byte-identical — and it is still the
      // converter's markers that say so, not the absence of a page.
      expect(ecjDocumentHtml(decision)).toEqual({
        boundary: "converter",
        html: decision,
      });
    },
  );

  /**
   * The boundary is also the answer to "is this converter output at
   * all". A page the publisher serves where a decision would be carries
   * site chrome and nothing else, and reports the fallback boundary —
   * which is what tells the adapter it is holding a page rather than a
   * layout it failed to recognise.
   */
  test("tells a page served instead of a decision from an unmatched one", async () => {
    const [shell, decision, page] = await Promise.all([
      readFixture(`${SHELL_STEM}.html.gz`),
      readFixture(
        `${manifestationStem({ celex: "62013TO0488", language: "CS" })}.html.gz`,
      ),
      readFixture(
        `${portalStem({ celex: "62022CJ0128", language: "EN" })}.html.gz`,
      ),
    ]);
    if (shell === undefined || decision === undefined || page === undefined) {
      throw new Error(`Missing the ${SHELL_STEM} recording or its decision`);
    }

    // Two of the publisher's own annotations, and the refusal needs both.
    // The shell has the site's component library and no converter output.
    expect(ecjDocumentRoot(cheerio.load(shell)).boundary).toBe("page-chrome");
    // The same decision, in the language the Court did publish it in:
    // without this the assertion above would hold of a parser that had
    // simply stopped finding markers anywhere.
    expect(ecjDocumentRoot(cheerio.load(decision)).boundary).toBe("converter");
    expect(ecjPageCarriesChrome(cheerio.load(decision))).toBe(false);
    // The portal page carries both, and the converter's markers decide:
    // there is a decision inside it, so it is bounded, not refused.
    expect(ecjPageCarriesChrome(cheerio.load(page))).toBe(true);
    expect(ecjDocumentRoot(cheerio.load(page)).boundary).toBe("converter");
    // A layout this parser does not recognise is unmatched, not a page.
    // It keeps the whole body, which is what rule 10 requires of it.
    expect(
      ecjDocumentRoot(cheerio.load("<html><body><p>Rozsudok</p></body></html>"))
        .boundary,
    ).toBe("document");
  });

  test("no recording of a decision carries the publisher's chrome", async () => {
    // The chrome half of the pair, over the whole corpus: a bare
    // manifestation is converter output and nothing else, in every layout,
    // including the pre-v9 spelling that carries no `coj-` class at all.
    for (const stem of decisionStems) {
      const html = await readFixture(`${stem}.html.gz`);
      if (html === undefined || stem.endsWith(PORTAL_STEM_SUFFIX)) {
        continue;
      }
      expect({
        stem,
        chrome: ecjPageCarriesChrome(cheerio.load(html)),
      }).toEqual({ stem, chrome: false });
    }
  });

  test("holds one declared shell recording", () => {
    // A shell on disk that nothing declares would silently sit out the
    // decision corpus's assertions, which is the opposite of coverage.
    const recorded = fixtureStems
      .filter((stem) => stem.endsWith(SHELL_STEM_SUFFIX))
      .sort();

    expect(recorded).toEqual([SHELL_STEM]);
  });

  test("compares every portal recording it holds", () => {
    // The other direction of the check above: a recording on disk that
    // no entry declares is never compared against anything, and would
    // sit there reading as coverage.
    const recorded = fixtureStems
      .filter((stem) => stem.endsWith(PORTAL_STEM_SUFFIX))
      .sort();

    expect(recorded).toEqual(PORTAL_CORPUS.map(portalStem).sort());
  });

  /**
   * The boundary is the deepest element holding every marker, and a
   * marked element that holds the others is that boundary itself. Taking
   * its container instead — which is what the oldest layout needs, since
   * its one marker is its own wrapper — would step back out into the
   * page around it.
   */
  test("keeps the boundary at a marked element that holds the rest", () => {
    const html = [
      "<html><body><div class='page'>",
      "<p class='site-nav'>Navigation, contact and telephone options</p>",
      "<div class='coj-normal' lang='en'>",
      "<p class='coj-sum-title-1'>ORDER OF THE COURT</p>",
      "<p class='coj-normal'>Body paragraph.</p>",
      "</div>",
      "<p class='site-footer'>Legal notice and cookies</p>",
      "</div></body></html>",
    ].join("");

    const { documentAst } = parseEcjDecisionHtml({
      caseNumber: "C-1/00",
      ecli: undefined,
      court: "Court of Justice",
      decisionDate: undefined,
      decisionType: undefined,
      sourceUrl: undefined,
      celex: "62000CJ0001",
      html,
    });

    expect(documentAst.blocks.map((block) => block.plainText)).toEqual([
      "ORDER OF THE COURT",
      "Body paragraph.",
    ]);
  });

  /**
   * The counterpart of the test above, and the reason the promotion it
   * pins is not simply removed: the oldest layout annotates nothing but
   * its wrapper, so the document is the wrapper's container, and text
   * the publisher put beside the wrapper is still the decision's.
   */
  test("keeps container text when only the wrapper is marked", () => {
    const html = [
      "<html><body><div class='listNotice'>",
      "<p>Case reference line</p>",
      "<div class='texte'><p>Body paragraph.</p></div>",
      "</div></body></html>",
    ].join("");

    const { documentAst } = parseEcjDecisionHtml({
      caseNumber: "C-1/00",
      ecli: undefined,
      court: "Court of Justice",
      decisionDate: undefined,
      decisionType: undefined,
      sourceUrl: undefined,
      celex: "62000CJ0001",
      html,
    });

    expect(documentAst.blocks.map((block) => block.plainText)).toEqual([
      "Case reference line",
      "Body paragraph.",
    ]);
  });

  /**
   * Rule 10 as an invariant rather than an example: a row shape the
   * marker/content rules do not match is still walked for its text.
   * The converter emits a numbered paragraph as a two-cell row, so the
   * shape rules read cell 1 as the marker and cell 2 as its content —
   * but a decision quoting a tariff or rate table carries a column per
   * heading, description and rate, and a header row of `th`. Asserted
   * across the row shapes rather than on one of them, because losing a
   * cell is invisible downstream: the AST reads as complete.
   */
  test("keeps every cell of every row shape", () => {
    const cellText = (row: number, cell: number) => `r${row}c${cell} content`;
    const shapes = [1, 2, 3, 4, 5];
    const rows = shapes
      .map((cellCount, row) => {
        const tag = row % 2 === 0 ? "td" : "th";
        const cells = Array.from(
          { length: cellCount },
          (_, cell) => `<${tag}><p>${cellText(row, cell)}</p></${tag}>`,
        ).join("");
        return `<tr>${cells}</tr>`;
      })
      .join("");
    const html = [
      "<html><body><div class='coj-normal' lang='en'>",
      "<p class='coj-sum-title-1'>JUDGMENT OF THE COURT</p>",
      `<table><tbody>${rows}</tbody></table>`,
      "</div></body></html>",
    ].join("");

    const { fulltext } = parseEcjDecisionHtml({
      caseNumber: "C-1/00",
      ecli: undefined,
      court: "Court of Justice",
      decisionDate: undefined,
      decisionType: undefined,
      sourceUrl: undefined,
      celex: "62000CJ0001",
      html,
    });

    const missing = shapes.flatMap((cellCount, row) =>
      Array.from({ length: cellCount }, (_, cell) =>
        cellText(row, cell),
      ).filter((text) => !fulltext.includes(text)),
    );
    expect(missing).toEqual([]);
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
