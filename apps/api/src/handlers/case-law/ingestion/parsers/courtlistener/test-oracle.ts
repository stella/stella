/**
 * Test support: the recorded opinion fixtures, and a text-conservation oracle
 * that shares no code with the parsers.
 *
 * The oracle reads a column's words through a different DOM (slimdom for
 * XML, cheerio's HTML text for preformatted bodies, the raw string for plain
 * text) and drops only the declared removals: printed page labels and note
 * backlinks. A parse conserves its source when both word multisets agree,
 * which proves no word lost and no paragraph repeated.
 */

import { panic } from "better-result";
import * as cheerio from "cheerio";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import * as slimdom from "slimdom";

import { type Block, plainTextOf } from "@/api/handlers/case-law/document-ast";
import {
  isCsvRow,
  OPINION_COLUMNS,
} from "@/api/handlers/case-law/ingestion/adapters/courtlistener/snapshot-columns";
import { isOpinionType } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/vocabulary";
import { isRecord } from "@/api/lib/type-guards";

import type { CourtListenerTextOpinion } from "./compose";
import type { TextStructure } from "./select";

const isOpinionRow = isCsvRow(OPINION_COLUMNS);

/** The opinion rows of a record line, typed as the parsers read them. */
const textOpinionsOf = (record: unknown): CourtListenerTextOpinion[] => {
  const rows = isRecord(record) ? record["opinions"] : null;
  if (!Array.isArray(rows)) {
    return panic("record without opinion rows");
  }
  return rows.map((row: unknown) => {
    if (!isOpinionRow(row) || !isOpinionType(row.type)) {
      return panic("opinion row off the pinned header");
    }
    return { row, type: row.type };
  });
};

/** `courtlistener-opinions-2026-06-30.ndjson.gz`, by cluster ID. */
export const recordedOpinionClusters = (): ReadonlyMap<
  string,
  CourtListenerTextOpinion[]
> =>
  new Map(
    gunzipSync(
      readFileSync(
        new URL(
          "../__fixtures__/courtlistener-opinions-2026-06-30.ndjson.gz",
          import.meta.url,
        ),
      ),
    )
      .toString("utf-8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const record: unknown = JSON.parse(line);
        const cluster = isRecord(record) ? record["cluster"] : null;
        const id = isRecord(cluster) ? cluster["id"] : null;
        if (typeof id !== "string") {
          return panic("record without a cluster ID");
        }
        return [id, textOpinionsOf(record)] as const;
      }),
  );

const INLINE_ELEMENTS = new Set([
  "a",
  "b",
  "bracketnum",
  "cite",
  "em",
  "extracted-citation",
  "footnotemark",
  "i",
  "page-number",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "u",
]);

const classList = (element: slimdom.Element): string[] =>
  (element.getAttribute("class") ?? "").split(/\s+/u);

const isDeclaredRemoval = (element: slimdom.Element): boolean => {
  const name = element.localName.toLowerCase();
  const classes = classList(element);
  const parent = element.parentElement;
  return (
    name === "page-number" ||
    (name === "span" && classes.includes("star-pagination")) ||
    (name === "a" && classes.includes("page-label")) ||
    (name === "a" &&
      classes.includes("footnote") &&
      parent !== null &&
      classList(parent).includes("footnote") &&
      parent.localName.toLowerCase() === "div")
  );
};

const xmlText = (node: slimdom.Node): string => {
  // CDATA is text in XML; an oracle skipping it certifies its loss.
  if (
    node.nodeType === slimdom.Node.TEXT_NODE ||
    node.nodeType === slimdom.Node.CDATA_SECTION_NODE
  ) {
    return node.nodeValue ?? "";
  }
  if (
    !(node instanceof slimdom.Element) &&
    !(node instanceof slimdom.Document)
  ) {
    return "";
  }
  if (node instanceof slimdom.Element) {
    const name = node.localName.toLowerCase();
    if (name === "script" || name === "style" || isDeclaredRemoval(node)) {
      return "";
    }
    const inner = node.childNodes.map(xmlText).join("");
    return INLINE_ELEMENTS.has(name) ? inner : ` ${inner} `;
  }
  return node.childNodes.map(xmlText).join("");
};

const words = (text: string): string[] =>
  text.split(/\s+/u).filter((word) => word !== "");

/** The words a reader of `source` sees, per the structure it holds. */
export const sourceWords = (
  structure: TextStructure,
  source: string,
): string[] => {
  switch (structure) {
    case "xml":
      return words(
        xmlText(
          slimdom.parseXmlDocument(
            `<oracle>${source.replace(/^\s*<\?xml[^?]*\?>/u, "")}</oracle>`,
          ),
        ),
      );
    case "pre": {
      const $ = cheerio.load(source);
      $("script, style").remove();
      return words($.root().text());
    }
    case "plain":
    case "html":
      return words(source);
    default: {
      structure satisfies never;
      return panic("unknown structure");
    }
  }
};

/**
 * Every word the parsed blocks put on the raw text axis, which is before the
 * shared projection folds letter-spaced runs (`O P I N I O N`).
 */
export const parsedWords = (blocks: readonly Block[]): string[] =>
  blocks.flatMap((block) => {
    switch (block.type) {
      case "table":
        return block.rows
          .flat()
          .flatMap(({ inlines }) => words(plainTextOf(inlines)));
      case "image":
        return words(block.plainText);
      case "heading":
      case "paragraph":
        return words(plainTextOf(block.inlines));
      default: {
        block satisfies never;
        return panic("unknown block");
      }
    }
  });

/** Words one side has more often than the other, both ways. */
export const wordDifference = (
  expected: readonly string[],
  actual: readonly string[],
): { missing: string[]; extra: string[] } => {
  const counts = new Map<string, number>();
  for (const word of expected) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  for (const word of actual) {
    counts.set(word, (counts.get(word) ?? 0) - 1);
  }
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [word, count] of counts) {
    for (let index = 0; index < Math.abs(count); index += 1) {
      (count > 0 ? missing : extra).push(word);
    }
  }
  return { missing, extra };
};
