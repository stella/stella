/**
 * The Court's own HTML, which the Office publishes for a translation before
 * (and sometimes instead of) the converter's XHTML.
 *
 * It carries none of the `coj-*` vocabulary the parser keys on, so nothing in
 * it is promoted to a heading or a numbered paragraph. What has to hold is
 * the parser's first rule: every word the Court wrote reaches the stored
 * text, and the response is read as a decision rather than as a page.
 */

import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";

import { parseEcjDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/eu-ecj";

const FIXTURE = new URL(
  "__fixtures__/eu-ecj-court-html/62026CO0122.cs.html.gz",
  import.meta.url,
);

const html = new TextDecoder().decode(
  Bun.gunzipSync(await Bun.file(FIXTURE).bytes()),
);

const words = (text: string): string[] =>
  text.split(/[\s ]+/u).filter((word) => word.length > 0);

describe("an order published only as the Court's HTML", () => {
  const parsed = parseEcjDecisionHtml({
    caseNumber: "C-122/26",
    ecli: "ECLI:EU:C:2026:829",
    court: "Court of Justice",
    decisionDate: "2026-10-06",
    decisionType: "order",
    sourceUrl: undefined,
    language: "cs",
    celex: "62026CO0122",
    html,
  });

  test("is read as the decision, with no text lost", () => {
    // The fixture is the markup the crawl now fetches for a variant it
    // could not list before; it must not be the converter's vocabulary, or
    // this asserts nothing about the other layout.
    expect(html).not.toContain("coj-");
    expect(parsed.boundary).not.toBe("page-chrome");
    expect(parsed.validationIssues).not.toContain("CONTENT_LOSS");
    expect(parsed.validationIssues).not.toContain("MISSING_WORDS");
    expect(parsed.documentAst.blocks.length).toBeGreaterThan(50);
  });

  test("keeps every word of the body in order", () => {
    const body = cheerio.load(html)("body").text();
    const stored = words(parsed.fulltext);
    const source = words(body);
    let cursor = 0;
    for (const word of source) {
      const found = stored.indexOf(word, cursor);
      expect(found).toBeGreaterThanOrEqual(cursor);
      cursor = found + 1;
    }
    expect(parsed.fulltext).toContain("Ve věci C‑122/26 P");
    expect(parsed.fulltext).toContain(
      "Ve zbývající části se kasační opravný prostředek neuznává přijatelným.",
    );
  });
});
