/**
 * Formex 4 reader, used only as a test oracle for the CJEU parser.
 *
 * Cellar publishes every CJEU decision twice: as the `coj-*` XHTML the
 * `eu-ecj` parser reads, and as the Formex XML both renderings are
 * generated from. Formex is explicitly semantic — `GR.SEQ` carries a
 * `LEVEL`, `NP.ECR` carries the paragraph number, `KEYWORD` lists the
 * subject-matter chain — so it can state, independently of any
 * class-name reading, what the document's structure actually is.
 *
 * Keeping this out of the parser is deliberate: Formex is not always
 * published for a decision (older manifestations ship a zip, some ship
 * none), so ingestion cannot depend on it. It is authoritative enough
 * to check the parser against, not available enough to parse from.
 */

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

export type FormexHeading = {
  /** Formex nesting depth, clamped to the AST's 1–3 heading levels. */
  level: 1 | 2 | 3;
  text: string;
};

export type FormexDocument = {
  /** Root element: JUDGMENT, ORDER or CONCLUSION (AG opinion). */
  kind: string;
  keywords: string[];
  headings: FormexHeading[];
  /** Numbers of the court's own numbered paragraphs, in document order. */
  paragraphNumbers: number[];
  /** Operative-part items, present on judgments and orders. */
  operativeItems: string[];
  hasSignature: boolean;
};

export const normalizeOracleText = (text: string): string =>
  text.replace(/\s+/gu, " ").trim();

const clampLevel = (raw: string | undefined): 1 | 2 | 3 => {
  const level = Number.parseInt(raw ?? "1", 10);
  if (level <= 1) {
    return 1;
  }
  return level === 2 ? 2 : 3;
};

/**
 * AG opinions split a heading into its number (`NO.P`, "I.") and its
 * text (`TXT`, "Introduction"). Formex stores them as adjacent elements
 * with no whitespace between them, while the rendering separates them
 * with a space, so join on element boundaries rather than on raw text.
 */
const headingText = (
  $: cheerio.CheerioAPI,
  title: cheerio.Cheerio<AnyNode>,
): string => {
  const parts = title.find("NO\\.P, TXT").toArray();
  if (parts.length === 0) {
    return normalizeOracleText(title.text());
  }
  return normalizeOracleText(
    parts.map((part) => normalizeOracleText($(part).text())).join(" "),
  );
};

export const parseFormex = (xml: string): FormexDocument => {
  const $ = cheerio.load(xml, { xml: true });

  // Formex models quotation marks as empty elements carrying the
  // codepoint; the rendering emits the character. Materialize them so
  // quoted terms inside headings and keywords compare literally.
  $("QUOT\\.START, QUOT\\.END, QUOT\\.S").each((_, el) => {
    const code = $(el).attr("CODE");
    $(el).replaceWith(
      code === undefined ? "" : String.fromCodePoint(Number.parseInt(code, 16)),
    );
  });

  const headings: FormexHeading[] = [];
  $("GR\\.SEQ").each((_, el) => {
    const title = $(el).children("TITLE").first();
    if (title.length === 0) {
      return;
    }
    headings.push({
      level: clampLevel($(el).attr("LEVEL")),
      text: headingText($, title),
    });
  });

  const paragraphNumbers: number[] = [];
  $("NP\\.ECR > NO\\.P").each((_, el) => {
    const value = Number.parseInt(normalizeOracleText($(el).text()), 10);
    if (Number.isInteger(value)) {
      paragraphNumbers.push(value);
    }
  });

  const operativeItems: string[] = [];
  $("JURISDICTION ITEM > NP > TXT").each((_, el) => {
    operativeItems.push(normalizeOracleText($(el).text()));
  });

  return {
    kind: $("*").first().prop("tagName") ?? "",
    keywords: $("INDEX > KEYWORD")
      .toArray()
      .map((el) => normalizeOracleText($(el).text())),
    headings,
    paragraphNumbers,
    operativeItems,
    hasSignature: $("SIGNATURE\\.CASE").length > 0,
  };
};
