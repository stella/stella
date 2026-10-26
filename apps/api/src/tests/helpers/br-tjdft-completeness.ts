import * as cheerio from "cheerio";

import type { Block } from "@stll/legal-ast/document-ast";

import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";

/** The validator codes that mean text was lost or markup leaked (rule 10). */
const COMPLETENESS_CODES: ReadonlySet<string> = new Set([
  "CONTENT_LOSS",
  "MISSING_WORDS",
  "MARKUP_RESIDUE",
  "EMPTY_AST",
]);

const BLOCK_EDGES = [
  "address",
  "article",
  "aside",
  "blockquote",
  "center",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
].join(", ");

/**
 * The completeness issues of a TJDFT parse against the court's HTML.
 *
 * The validator reads a cell's text as one string, so the paragraphs the
 * court sets inside a vote's cell run together ("semiaberto.O voto") and read
 * as words the document lacks. A space after every block keeps them apart,
 * as a renderer does; it adds and removes no word.
 */
export const brTjdftCompletenessIssues = (
  html: string,
  blocks: Block[],
): string[] => {
  const document = cheerio.load(html);
  document(BLOCK_EDGES).after(" ");
  return validateAst(html, blocks, { document })
    .issues.map(({ code }) => code)
    .filter((code) => COMPLETENESS_CODES.has(code));
};
