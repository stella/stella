/**
 * The occurrence pass against a published decision whose publisher marked
 * its own citations.
 *
 * The capture's citation anchors are removed before extraction, so the pass
 * sees only the characters, emphasis, footnotes and page boundaries a parser
 * would give it; the anchors are read separately, from the untouched capture,
 * as the oracle. Only the anchors this pass supports are compared, and the
 * ones it abstains on are listed rather than claimed.
 */

import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";
import { isTag, isText } from "domhandler";
import type { AnyNode } from "domhandler";

import { canonicalUsReporterCitation } from "@stll/api-contract/us-reporter-citation";
import type {
  CitationUnresolvedReason,
  InlineCitationTarget,
} from "@stll/legal-ast/inline";

import { extractDecisionCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { annotateUsCitations } from "@/api/handlers/case-law/ingestion/us-citation-annotations";
import type { UsCitationOccurrence } from "@/api/handlers/case-law/ingestion/us-citation-occurrences";
import { plainTextOf, projectPlainText } from "@/api/lib/case-law/document-ast";
import type {
  Block,
  DocumentAst,
  Inline,
} from "@/api/lib/case-law/document-ast";
import type { CitationOpinionScope } from "@/api/lib/legal-search/ingestion-types";

const unbounded = () => ({ limit: Number.POSITIVE_INFINITY, spent: 0 });

const FIXTURE_URL = new URL(
  "parsers/__fixtures__/us-cap-347-0483-01.html",
  import.meta.url,
);

type OracleSpan = {
  index: number;
  blockId: string;
  start: number;
  end: number;
  cite: string;
};

type CapturedDocument = {
  ast: DocumentAst;
  scopes: CitationOpinionScope[];
  oracle: OracleSpan[];
};

/**
 * The capture as a parser would read it: paragraphs and block quotations as
 * blocks, footnotes as note paragraphs, emphasis as italic, page labels as
 * page anchors, note marks as superscripts, and each opinion as a scope.
 * Citation anchors are transparent here; their spans are recorded instead.
 */
const readCapturedDocument = (html: string): CapturedDocument => {
  const $ = cheerio.load(html);
  const blocks: Block[] = [];
  const scopes: CitationOpinionScope[] = [];
  const oracle: OracleSpan[] = [];

  const inlinesOf = (
    nodes: readonly AnyNode[],
    blockId: string,
    offset: { value: number },
  ): Inline[] => {
    const out: Inline[] = [];
    for (const node of nodes) {
      if (isText(node)) {
        const text = node.data.replace(/\s+/gu, " ");
        if (text !== "") {
          out.push({ type: "text", text });
          offset.value += text.length;
        }
        continue;
      }
      if (!isTag(node)) {
        continue;
      }
      const classes = node.attribs["class"] ?? "";
      if (node.name === "a" && classes.includes("page-label")) {
        out.push({
          type: "page-anchor",
          label: node.attribs["data-label"] ?? "",
        });
      } else if (node.name === "a" && classes.includes("footnotemark")) {
        const children = inlinesOf(node.children, blockId, offset);
        out.push({ type: "superscript", children });
      } else if (node.name === "a" && classes.includes("citation")) {
        const start = offset.value;
        out.push(...inlinesOf(node.children, blockId, offset));
        oracle.push({
          index: Number(node.attribs["data-index"]),
          blockId,
          start,
          end: offset.value,
          cite: node.attribs["data-cite"] ?? "",
        });
      } else if (node.name === "em" || node.name === "i") {
        out.push({
          type: "italic",
          children: inlinesOf(node.children, blockId, offset),
        });
      } else if (node.name === "br") {
        out.push({ type: "line-break" });
        offset.value += 1;
      } else {
        out.push(...inlinesOf(node.children, blockId, offset));
      }
    }
    return out;
  };

  const pushBlock = (
    element: AnyNode,
    extra: Pick<Extract<Block, { type: "paragraph" }>, "note" | "role">,
  ): string => {
    if (!isTag(element)) {
      return "";
    }
    const id = element.attribs["id"] ?? `block-${String(blocks.length)}`;
    const children = element.children.filter(
      (child) =>
        !(isTag(child) && (child.attribs["href"] ?? "").startsWith("#ref_")),
    );
    const inlines = inlinesOf(children, id, { value: 0 });
    blocks.push({
      id,
      anchorId: id,
      type: "paragraph",
      ...extra,
      inlines,
      plainText: projectPlainText(inlines),
    });
    return id;
  };

  $("section.head-matter")
    .children()
    .each((_, element) => {
      pushBlock(element, {});
    });
  $("article.opinion").each((opinionIndex, article) => {
    const opinionId = `${$(article).attr("data-type") ?? "opinion"}-${String(opinionIndex)}`;
    const blockIds: string[] = [];
    $(article)
      .children()
      .each((_, element) => {
        if (!isTag(element)) {
          return;
        }
        if (element.name === "aside") {
          const label = element.attribs["data-label"] ?? "";
          const noteId = element.attribs["id"] ?? label;
          $(element)
            .children("p, blockquote")
            .each((__, paragraph) => {
              blockIds.push(
                pushBlock(paragraph, {
                  note: { type: "footnote", label, noteId },
                }),
              );
            });
          return;
        }
        blockIds.push(
          pushBlock(
            element,
            element.name === "blockquote" ? { role: "quote" } : {},
          ),
        );
      });
    scopes.push({ opinionId, blockIds });
  });

  return {
    ast: {
      version: 1,
      source: {
        system: "capture",
        documentId: "347-0483-01",
        webUrl: "",
        printUrl: "",
      },
      metadata: {
        caseNumber: null,
        ecli: null,
        court: null,
        decisionDate: null,
        decisionType: null,
        keywords: [],
        statutes: [],
      },
      blocks,
    },
    scopes,
    oracle,
  };
};

/** The capture with every citation anchor unwrapped, its text kept. */
const withoutCitationMarkup = (html: string): string => {
  const $ = cheerio.load(html, null, false);
  $("a.citation").each((_, anchor) => {
    $(anchor).replaceWith($(anchor).contents());
  });
  return $.html();
};

const capture = await Bun.file(FIXTURE_URL).text();
const annotated = readCapturedDocument(capture);
const input = readCapturedDocument(withoutCitationMarkup(capture));

const extracted = extractDecisionCitations({
  country: "USA",
  sections: [],
  documentAst: input.ast,
  citationScopes: input.scopes,
});
if (Result.isError(extracted)) {
  throw extracted.error;
}
const { citations, occurrences } = extracted.value;

/** One oracle citation, joined across the anchors the publisher split it into. */
const oracleCitation = (index: number) => {
  const pieces = annotated.oracle.filter((span) => span.index === index);
  const first = pieces.at(0);
  const last = pieces.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error(`No oracle citation ${String(index)}`);
  }
  return {
    blockId: first.blockId,
    start: first.start,
    end: last.end,
    cite: first.cite,
  };
};

/**
 * Oracle anchors naming no single reporter decision, so never compared: the
 * statutes, and a nominative reporter several records publish under.
 */
const UNSUPPORTED_ORACLE = new Set([11, 13, 14, 18, 19, 21, 28]);

const occurrencesIn = ({
  blockId,
  end,
  start,
}: {
  blockId: string;
  start: number;
  end: number;
}) =>
  occurrences.filter(
    (occurrence) =>
      occurrence.blockId === blockId &&
      occurrence.start < end &&
      occurrence.end > start,
  );

const identifiedAs = (value: string): InlineCitationTarget => ({
  status: "identified",
  identifiers: [{ type: "reporter-citation", value }],
});

const textOf = (occurrence: UsCitationOccurrence): string => {
  const block = input.ast.blocks.find(({ id }) => id === occurrence.blockId);
  return block?.type === "paragraph"
    ? plainTextOf(block.inlines).slice(occurrence.start, occurrence.end)
    : "";
};

type Expected = readonly [
  blockId: string,
  text: string,
  form: UsCitationOccurrence["form"],
  target: readonly string[] | CitationUnresolvedReason,
];

/**
 * Every reporter occurrence in the capture, reviewed against the publisher's
 * anchors and the text: its block, its printed span, its form, and the exact
 * identifiers it names or the reason it abstains.
 */
const EXPECTED: readonly Expected[] = [
  ["b561-3", "163 U. S. 537", "full", ["163 U.S. 537"]],
  ["b564-6", "supra", "supra", ["163 U.S. 537"]],
  ["b564-6", "175 U. S. 528", "full", ["175 U.S. 528"]],
  ["b564-6", "275 U. S. 78", "full", ["275 U.S. 78"]],
  ["b564-6", "305 U. S. 337", "full", ["305 U.S. 337"]],
  ["b564-6", "332 U. S. 631", "full", ["332 U.S. 631"]],
  ["b564-6", "339 U. S. 629", "full", ["339 U.S. 629"]],
  ["b564-6", "339 U. S. 637", "full", ["339 U.S. 637"]],
  ["b564-6", "supra", "supra", ["339 U.S. 629"]],
  ["b567-6", "supra", "supra", ["339 U.S. 629"]],
  ["b567-6", "supra", "supra", ["339 U.S. 637"]],
  ["b560-8", "98 F. Supp. 797", "full", ["98 F. Supp. 797"]],
  ["b560-9", "98 F. Supp. 529", "full", ["98 F. Supp. 529"]],
  ["b560-9", "342 U. S. 350", "full", ["342 U.S. 350"]],
  ["b560-9", "103 F. Supp. 920", "full", ["103 F. Supp. 920"]],
  ["b561-5", "103 F. Supp. 337", "full", ["103 F. Supp. 337"]],
  ["b561-6", "87 A. 2d 862", "full", ["87 A.2d 862"]],
  ["b561-6", "Id., at 865", "id", ["87 A.2d 862"]],
  ["b561-6", "91 A. 2d 137, 152", "full", ["91 A.2d 137"]],
  ["b561-6", "344 U. S. 891", "full", ["344 U.S. 891"]],
  ["b562-8", "344 U. S. 1, 141, 891", "full", ["344 U.S. 1"]],
  ["b562-9", "345 U. S. 972", "full", ["345 U.S. 972"]],
  ["b563-5", "supra, at 269-275", "supra", "missing-antecedent"],
  ["b563-5", "supra, at 288-339, 408-431", "supra", "missing-antecedent"],
  ["b563-5", "supra, at 408-423", "supra", "missing-antecedent"],
  ["b563-5", "Id., at 427-428", "id", "authority-barrier"],
  ["b563-5", "supra, at 563-565", "supra", "missing-antecedent"],
  ["b564-11", "16 Wall. 36, 67-72", "full", "ambiguous-reporter"],
  ["b564-11", "100 U. S. 303, 307-308", "full", ["100 U.S. 303"]],
  ["b565-8", "100 U. S. 313, 318", "full", ["100 U.S. 313"]],
  ["b565-8", "100 U. S. 339, 344-345", "full", ["100 U.S. 339"]],
  ["b565-9", "59 Mass. 198, 206", "full", ["59 Mass. 198"]],
  ["b565-10", "211 U. S. 45", "full", ["211 U.S. 45"]],
  ["b566-8", "98 F. Supp. 797, 798", "full", ["98 F. Supp. 797"]],
  ["b566-8", "103 F. Supp. 920, 921", "full", ["103 F. Supp. 920"]],
  ["b566-8", "103 F. Supp. 337, 341", "full", ["103 F. Supp. 337"]],
  ["b566-8", "91 A. 2d 137, 149", "full", ["91 A.2d 137"]],
  ["b568-6", "87 A. 2d 862, 865", "full", ["87 A.2d 862"]],
];

/** An occurrence's identity for comparison: block, text, and which repeat. */
const keyOf = (
  occurrence: UsCitationOccurrence,
  earlier: readonly UsCitationOccurrence[],
): string => {
  const text = textOf(occurrence);
  const repeat = earlier.filter(
    (other) => other.blockId === occurrence.blockId && textOf(other) === text,
  ).length;
  return `${occurrence.blockId} ${text} #${String(repeat)}`;
};

type Classification = {
  matched: number;
  missing: string[];
  extra: string[];
  /** Named the expected identifiers and more besides. */
  extraAlias: string[];
  /** Named identifiers the review does not. */
  contradicted: string[];
  /** Abstained where the review names a decision, or the reverse. */
  wrongStatus: string[];
  wrongForm: string[];
};

const CLEAN: Classification = {
  matched: EXPECTED.length,
  missing: [],
  extra: [],
  extraAlias: [],
  contradicted: [],
  wrongStatus: [],
  wrongForm: [],
};

const classify = (actual: readonly UsCitationOccurrence[]): Classification => {
  const expectedByKey = new Map<string, Expected>();
  for (const entry of EXPECTED) {
    const [blockId, text] = entry;
    let repeat = 0;
    while (expectedByKey.has(`${blockId} ${text} #${String(repeat)}`)) {
      repeat += 1;
    }
    expectedByKey.set(`${blockId} ${text} #${String(repeat)}`, entry);
  }
  const result: Classification = {
    matched: 0,
    missing: [],
    extra: [],
    extraAlias: [],
    contradicted: [],
    wrongStatus: [],
    wrongForm: [],
  };
  const seen = new Set<string>();
  for (const [position, occurrence] of actual.entries()) {
    const key = keyOf(occurrence, actual.slice(0, position));
    const entry = expectedByKey.get(key);
    if (entry === undefined) {
      result.extra.push(key);
      continue;
    }
    seen.add(key);
    const form = entry[2];
    const expected = entry[3];
    const { target } = occurrence;
    const names =
      target.status === "identified"
        ? target.identifiers.map(({ value }) => value)
        : null;
    if (occurrence.form !== form) {
      result.wrongForm.push(key);
    } else if (typeof expected === "string") {
      if (names !== null || target.status !== "unresolved") {
        result.wrongStatus.push(key);
      } else if (target.reason === expected) {
        result.matched += 1;
      } else {
        result.wrongStatus.push(key);
      }
    } else if (names === null) {
      result.wrongStatus.push(key);
    } else if (
      names.length === expected.length &&
      names.every((name, index) => name === expected[index])
    ) {
      result.matched += 1;
    } else if (expected.every((name) => names.includes(name))) {
      result.extraAlias.push(key);
    } else {
      result.contradicted.push(key);
    }
  }
  result.missing = [...expectedByKey.keys()].filter((key) => !seen.has(key));
  return result;
};

describe("a published decision's own citation anchors", () => {
  test("the stripped capture carries exactly the annotated one's characters", () => {
    expect(input.oracle).toEqual([]);
    expect(input.ast.blocks.map((block) => block.plainText)).toEqual(
      annotated.ast.blocks.map((block) => block.plainText),
    );
    expect(annotated.oracle.length).toBeGreaterThan(0);
  });

  test("a full reference names its decision", () => {
    const plessy = oracleCitation(0);
    expect(occurrencesIn(plessy)).toEqual([
      expect.objectContaining({
        start: plessy.start,
        end: plessy.end,
        form: "full",
        target: identifiedAs("163 U.S. 537"),
      }),
    ]);
  });

  test("a named supra reaches the full reference its caption names", () => {
    const supra = oracleCitation(1);
    expect(occurrencesIn(supra)).toEqual([
      expect.objectContaining({
        start: supra.start,
        form: "supra",
        target: identifiedAs("163 U.S. 537"),
      }),
    ]);
  });

  test("an Id. split by emphasis is one occurrence carrying its pin", () => {
    const atlantic = oracleCitation(22);
    expect(occurrencesIn(atlantic)).toEqual([
      expect.objectContaining({
        start: atlantic.start,
        end: atlantic.end,
        target: identifiedAs("87 A.2d 862"),
      }),
    ]);
    const id = oracleCitation(23);
    const found = occurrencesIn(id);
    expect(found).toEqual([
      expect.objectContaining({
        start: id.start,
        end: id.end,
        form: "id",
        noteId: "footnote_1_1",
        target: identifiedAs("87 A.2d 862"),
        pin: {
          raw: "865",
          parts: [{ kind: "page", start: "865" }],
          reporter: { type: "reporter-citation", value: "87 A.2d 862" },
        },
      }),
    ]);
    expect(found.map(textOf)).toEqual(["Id., at 865"]);
  });

  test("a statute is never a case citation", () => {
    const statutes = annotated.oracle.filter(({ cite }) =>
      cite.includes("U.S.C."),
    );
    expect(statutes.length).toBeGreaterThan(0);
    for (const statute of statutes) {
      expect(occurrencesIn(statute)).toEqual([]);
    }
    expect(
      citations.filter(({ citationText }) => citationText.includes("C.")),
    ).toEqual([]);
  });

  test("a reporter spelling several records publish under abstains", () => {
    expect(
      occurrencesIn(oracleCitation(28)).map(({ target }) => target),
    ).toEqual([{ status: "unresolved", reason: "ambiguous-reporter" }]);
  });

  test("a supra naming a book stays unresolved", () => {
    const books = occurrences.filter(
      (occurrence) =>
        occurrence.form === "supra" &&
        occurrence.target.status === "unresolved",
    );
    expect(books.length).toBeGreaterThan(0);
    for (const book of books) {
      expect(book.target).toEqual({
        status: "unresolved",
        reason: "missing-antecedent",
      });
    }
  });

  test("reads exactly the reviewed occurrences", () => {
    expect(classify(occurrences)).toEqual(CLEAN);
  });

  test("the comparison catches an extra alias, a wrong target and an extra occurrence", () => {
    const identifiedAt = occurrences.findIndex(
      ({ target }) => target.status === "identified",
    );
    const original = occurrences[identifiedAt];
    if (original?.target.status !== "identified") {
      throw new Error("The capture reads no identified occurrence");
    }
    const withTarget = (target: InlineCitationTarget) =>
      occurrences.with(identifiedAt, { ...original, target });
    const key = keyOf(original, occurrences.slice(0, identifiedAt));
    const alias = { type: "reporter-citation", value: "1 S. Ct. 1" } as const;

    expect(
      classify(
        withTarget({
          status: "identified",
          identifiers: [...original.target.identifiers, alias],
        }),
      ),
    ).toEqual({ ...CLEAN, matched: EXPECTED.length - 1, extraAlias: [key] });
    expect(
      classify(withTarget({ status: "identified", identifiers: [alias] })),
    ).toEqual({ ...CLEAN, matched: EXPECTED.length - 1, contradicted: [key] });
    expect(
      classify([...occurrences, { ...original, start: 0, end: 1 }]).extra,
    ).toHaveLength(1);
  });

  test("each supported publisher anchor starts exactly one occurrence naming exactly its decision", () => {
    const indexes = [...new Set(annotated.oracle.map(({ index }) => index))];
    const readings = indexes
      .filter((index) => !UNSUPPORTED_ORACLE.has(index))
      .map((index) => {
        const anchor = oracleCitation(index);
        return {
          index,
          found: occurrencesIn(anchor).map(({ start, target }) => ({
            start,
            target,
          })),
        };
      });
    expect(readings).toEqual(
      readings.map(({ index }) => {
        const anchor = oracleCitation(index);
        const value = canonicalUsReporterCitation(anchor.cite);
        return {
          index,
          found: [
            {
              start: anchor.start,
              target:
                value === null
                  ? { status: "unresolved", reason: "ambiguous-reporter" }
                  : identifiedAs(value),
            },
          ],
        };
      }),
    );
  });

  test("a decision cited by several spellings and short forms is one edge", () => {
    const values = citations.map(({ identifierValue }) => identifierValue);
    expect(values).toEqual([...new Set(values)]);
    expect(values.filter((value) => value === "163 U.S. 537")).toHaveLength(1);
  });

  test("annotation keeps the text and is a fixed point", () => {
    const once = annotateUsCitations(
      input.ast,
      occurrences,
      unbounded(),
    ).unwrap();
    expect(
      once.blocks.map((block) =>
        block.type === "paragraph" ? plainTextOf(block.inlines) : "",
      ),
    ).toEqual(
      input.ast.blocks.map((block) =>
        block.type === "paragraph" ? plainTextOf(block.inlines) : "",
      ),
    );
    expect(
      annotateUsCitations(once, occurrences, unbounded()).unwrap(),
    ).toEqual(once);
  });
});
