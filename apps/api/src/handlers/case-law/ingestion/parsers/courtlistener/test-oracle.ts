/**
 * Test support for recorded opinion fixtures and a text-conservation oracle.
 * HTML is read by a lexical source walk; fixture tests declare excluded source
 * spans explicitly, without inferring publisher furniture from production rules.
 */

import { panic } from "better-result";
import * as cheerio from "cheerio";
import { decodeHTML } from "entities";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import * as slimdom from "slimdom";

import { type Block, plainTextOf } from "@stll/legal-ast/document-ast";

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

const NO_EXCLUDED_SPANS = { excludedSpans: [] } as const;

/** The words a reader of `source` sees, per the structure it holds. */
export const sourceWords = (
  structure: TextStructure,
  source: string,
  options: { excludedSpans: readonly SourceSpan[] } = NO_EXCLUDED_SPANS,
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
    case "html":
      return htmlWords(source, options.excludedSpans);
    case "plain":
      return words(source);
    default: {
      structure satisfies never;
      return panic("unknown structure");
    }
  }
};

const HTML_BLOCKS = new Set([
  "address",
  "article",
  "blockquote",
  "body",
  "bodytext",
  "br",
  "casebody",
  "center",
  "dd",
  "div",
  "dl",
  "dt",
  "footer",
  // CourtListener uses <h> for block headings, including adjacent siblings.
  "h",
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
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

export type SourceSpan = Readonly<{ start: number; end: number }>;

/** A deliberately small lexical walk: it knows HTML token boundaries, not publisher semantics. */
const htmlWords = (
  source: string,
  excludedSpans: readonly SourceSpan[],
): string[] => {
  const visible: string[] = [];
  let cursor = 0;
  let suppressedTag: string | null = null;
  const emit = (start: number, end: number): void => {
    if (suppressedTag !== null) {
      return;
    }
    const spans = excludedSpans
      .filter((span) => span.start < end && span.end > start)
      .toSorted((left, right) => left.start - right.start);
    let position = start;
    for (const span of spans) {
      const excludedStart = Math.max(position, span.start);
      if (excludedStart > position) {
        visible.push(decodeHTML(source.slice(position, excludedStart)));
      }
      position = Math.max(position, Math.min(end, span.end));
    }
    if (position < end) {
      visible.push(decodeHTML(source.slice(position, end)));
    }
  };
  while (cursor < source.length) {
    const opening = source.indexOf("<", cursor);
    const textEnd = opening === -1 ? source.length : opening;
    if (textEnd > cursor) {
      emit(cursor, textEnd);
    }
    if (opening === -1) {
      break;
    }
    if (source.startsWith("<!--", opening)) {
      const commentEnd = source.indexOf("-->", opening + 4);
      cursor = commentEnd === -1 ? source.length : commentEnd + 3;
      continue;
    }
    const next = source[opening + 1];
    const tagStart = next !== undefined && /[a-zA-Z!?]/u.test(next);
    const afterSlash = source[opening + 2];
    const closingTagStart =
      next === "/" && afterSlash !== undefined && /[a-zA-Z]/u.test(afterSlash);
    if (!tagStart && !closingTagStart) {
      emit(opening, opening + 1);
      cursor = opening + 1;
      continue;
    }
    const close = findTagEnd(source, opening + 1);
    if (close < 0) {
      emit(opening, opening + 1);
      cursor = opening + 1;
      continue;
    }
    const raw = source.slice(opening + 1, close);
    const prefix = raw.trimStart();
    const closing = prefix.startsWith("/");
    const name = /^([a-zA-Z][\w:-]*)/u
      .exec((closing ? prefix.slice(1) : prefix).trimStart())
      ?.at(1)
      ?.toLowerCase();
    cursor = close + 1;
    if (name === undefined) {
      continue;
    }
    if (suppressedTag !== null) {
      if (closing && name === suppressedTag) {
        suppressedTag = null;
      }
      continue;
    }
    if (
      name === "script" ||
      name === "style" ||
      name === "title" ||
      name === "template"
    ) {
      if (!closing && !/\/\s*$/u.test(raw)) {
        suppressedTag = name;
      }
      continue;
    }
    if (HTML_BLOCKS.has(name)) {
      visible.push(" ");
    }
  }
  return words(visible.join(""));
};

const findTagEnd = (source: string, from: number): number => {
  let quote: string | null = null;
  for (let index = from; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
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
