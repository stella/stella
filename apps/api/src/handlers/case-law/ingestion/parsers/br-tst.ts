/**
 * The Tribunal Superior do Trabalho's decision texts, as its search API
 * serves them, read into the canonical document.
 *
 * Three shapes reach this module, and each keeps the structure it has:
 *
 * - An acórdão's `inteiroTeorHtml`: a Word export, one `<p>` per printed
 *   paragraph with inline `<b>`, `<i>` and `<u>` inside presentational
 *   spans, pretty-printed so a paragraph's text carries the exporter's
 *   indentation. Recent exports keep the Word paragraph style as the `class`
 *   (`Identificaaao`, `Ementa`, `Voto`, `IstoaPosto`, `Transcriaao`, `Date`,
 *   `Autoridade`, `Funaao`: the style names with every non-ASCII letter
 *   written `a`); older ones print `class=default` throughout and carry no
 *   structure beyond the paragraph.
 * - A despacho's `txtConteudoDecisao`: either an HTML fragment wrapped in a
 *   literal `<![CDATA[ … ]]>` (one `<p align="justify">` per line), or plain
 *   text with one paragraph per line.
 * - A súmula, orientação jurisprudencial or precedente normativo: structured
 *   fields (title, thesis, note, history), the thesis one item per line with
 *   `<s>` around the items the court cancelled.
 *
 * Roles and headings come only from the publisher's own paragraph styles,
 * never from wording (rule 9): `Voto` and `IstoaPosto` open sections, the
 * identification block is the intro, transcriptions are quotations, and the
 * date, name and office close the document. A paragraph whose style is not in
 * that vocabulary, or a document with no styles, is a plain paragraph in
 * printed order (rule 10). `<u>` and `<s>` have no inline kind of their own
 * and keep only their text.
 */
import { panic, Result, TaggedError } from "better-result";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { isTag, isText } from "domhandler";

// parser-output-unchanged: imports the document AST from its package owner
import type {
  Block,
  DocumentAst,
  HeadingRole,
  Inline,
  ParagraphRole,
} from "@stll/legal-ast/document-ast";
import { hasInlineChildren } from "@stll/legal-ast/document-ast";
import { normalizeInlineLine } from "@stll/legal-ast/inline-line";

import {
  isExcludedHtmlTag,
  walkInlines,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";
import { sectionsFromAst } from "@/api/handlers/case-law/ingestion/sections-from-ast";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";

const SOURCE_SYSTEM = "jurisprudencia.tst.jus.br";

/** A text this parser cannot turn into a document. */
export class BrTstParseError extends TaggedError("BrTstParseError")<{
  message: string;
}> {}

/** What the stored row says about the document, for its metadata header. */
export type BrTstDocumentIdentity = {
  sourceDocumentId: string;
  caseNumber: string;
  court: string;
  decisionDate: string | undefined;
  decisionType: string;
};

export type BrTstParsedDocument = {
  documentAst: DocumentAst;
  fulltext: string;
  /** Present where the publisher's styles opened at least one section. */
  sections: DecisionSection[] | undefined;
};

type ParagraphStyle =
  | { type: "heading"; role: HeadingRole }
  | { type: "paragraph"; role: ParagraphRole };

/**
 * The Word paragraph styles the court's export names, and what each one is.
 * A style absent here is a body paragraph, not unknown text.
 */
const PARAGRAPH_STYLES = new Map(
  Object.entries({
    Identificaaao: { type: "paragraph", role: "intro" },
    Voto: { type: "heading", role: "section-heading" },
    IstoaPosto: { type: "heading", role: "section-heading" },
    Transcriaao: { type: "paragraph", role: "quote" },
    Transcriaaoaa: { type: "paragraph", role: "quote" },
    Date: { type: "paragraph", role: "closing" },
    Autoridade: { type: "paragraph", role: "signature" },
    Ministro: { type: "paragraph", role: "signature" },
    Funaao: { type: "paragraph", role: "signature" },
  } as const satisfies Record<string, ParagraphStyle>),
);

/** The publisher's paragraph styles this parser gives a role or a heading. */
export const BR_TST_PARAGRAPH_STYLES: readonly string[] = [
  ...PARAGRAPH_STYLES.keys(),
];

/**
 * One space per gap, wherever the gap falls between nodes.
 *
 * The export indents and wraps inside a paragraph, so its text nodes carry
 * newlines and runs of spaces the printed page never had, and a gap often
 * straddles a `</b>` or a `</span>`. A line break is itself the boundary, so
 * the text after it starts without one.
 */
const collapseWhitespace = (inlines: readonly Inline[]): Inline[] => {
  let afterGap = true;
  const walk = (nodes: readonly Inline[]): Inline[] =>
    nodes.flatMap((node): Inline[] => {
      if (node.type === "text") {
        const collapsed = node.text.replace(/\s+/gu, " ");
        const text = afterGap ? collapsed.replace(/^ /u, "") : collapsed;
        if (text === "") {
          return [];
        }
        afterGap = text.endsWith(" ");
        return [{ ...node, text }];
      }
      if (node.type === "line-break") {
        afterGap = true;
        return [node];
      }
      if (!hasInlineChildren(node)) {
        return [node];
      }
      const children = walk(node.children);
      return children.length === 0 ? [] : [{ ...node, children }];
    });
  return walk(inlines);
};

type Line = ReturnType<typeof normalizeInlineLine>;

const lineOf = (inlines: readonly Inline[]): Line | undefined => {
  const line = normalizeInlineLine(collapseWhitespace(inlines));
  return line.plainText === "" ? undefined : line;
};

type BlockDraft = { style: ParagraphStyle | undefined; line: Line };

const numberedBlocks = (drafts: readonly BlockDraft[]): Block[] =>
  drafts.map(({ style, line }, index): Block => {
    const position = index + 1;
    if (style?.type === "heading") {
      return {
        id: `b${position}`,
        anchorId: `h-${position}`,
        type: "heading",
        level: 1,
        role: style.role,
        inlines: line.inlines,
        plainText: line.plainText,
      };
    }
    return {
      id: `b${position}`,
      anchorId: `p-${position}`,
      type: "paragraph",
      ...(style === undefined ? {} : { role: style.role }),
      inlines: line.inlines,
      plainText: line.plainText,
    };
  });

/**
 * Every paragraph under `root`, in printed order.
 *
 * A `<p>` is one paragraph. Text outside any `<p>` still reaches the document
 * as a paragraph of its own, and an element that holds paragraphs or other
 * blocks (a `<div>`, a table row or cell, a list item) is walked into rather
 * than flattened, so nothing the export prints is dropped for sitting
 * somewhere unexpected, and two blocks never run together into one word.
 */
/**
 * Elements a browser lays out as a block of their own: the boundary between
 * two of them separates words even where the markup puts no space there.
 */
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "caption",
  "center",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
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
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** Whether `node` holds a block anywhere below it. */
const holdsBlock = (node: AnyNode): boolean =>
  isTag(node) &&
  node.children.some(
    (child) =>
      isTag(child) && (BLOCK_TAGS.has(child.name) || holdsBlock(child)),
  );

const htmlDrafts = (
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<AnyNode>,
): BlockDraft[] => {
  const drafts: BlockDraft[] = [];
  const push = (style: ParagraphStyle | undefined, inlines: Inline[]) => {
    const line = lineOf(inlines);
    if (line !== undefined) {
      drafts.push({ style, line });
    }
  };
  const visit = (node: AnyNode): void => {
    if (isText(node)) {
      push(undefined, [{ type: "text", text: node.data }]);
      return;
    }
    if (!isTag(node) || isExcludedHtmlTag(node.name)) {
      return;
    }
    const element = $(node);
    if (node.name === "p") {
      const className = element.attr("class");
      push(
        className === undefined ? undefined : PARAGRAPH_STYLES.get(className),
        walkInlines($, element),
      );
      return;
    }
    if (!holdsBlock(node)) {
      push(undefined, walkInlines($, element));
      return;
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const node of root.contents().toArray()) {
    visit(node);
  }
  return drafts;
};

/**
 * The document, or a typed failure when nothing in the text survived. Text
 * retention is the pipeline's to validate, against the stored source.
 */
const assemble = (
  identity: BrTstDocumentIdentity,
  blocks: Block[],
): Result<BrTstParsedDocument, BrTstParseError> => {
  if (blocks.length === 0) {
    return Result.err(
      new BrTstParseError({
        message: `TST document ${identity.sourceDocumentId} holds no text`,
      }),
    );
  }
  return Result.ok({
    documentAst: {
      version: 1,
      source: {
        system: SOURCE_SYSTEM,
        documentId: identity.sourceDocumentId,
        webUrl: "",
        printUrl: "",
      },
      metadata: {
        caseNumber: identity.caseNumber,
        ecli: null,
        court: identity.court,
        decisionDate: identity.decisionDate ?? null,
        decisionType: identity.decisionType,
        keywords: [],
        statutes: [],
      },
      blocks,
    },
    fulltext: blocks.map((block) => block.plainText).join("\n\n"),
    sections: blocks.some((block) => block.type === "heading")
      ? sectionsFromAst(blocks)
      : undefined,
  });
};

/** An acórdão's `inteiroTeorHtml`, or a despacho's HTML fragment. */
export const parseBrTstHtml = (
  html: string,
  identity: BrTstDocumentIdentity,
): Result<BrTstParsedDocument, BrTstParseError> => {
  const $ = cheerio.load(html);
  return assemble(identity, numberedBlocks(htmlDrafts($, $("body"))));
};

const CDATA_OPEN = "<![CDATA[";
const CDATA_CLOSE = "]]>";

/**
 * A despacho's text in the form the publisher wrote it.
 *
 * The HTML form arrives inside a literal CDATA section. Read as HTML, the
 * whole wrapper is one bogus comment and the decision would vanish, so the
 * wrapper is opened by its exact delimiters; anything else is the plain form.
 */
export type BrTstDespachoText =
  { type: "html"; html: string } | { type: "text"; text: string };

export const brTstDespachoTextOf = (value: string): BrTstDespachoText => {
  const trimmed = value.trim();
  return trimmed.startsWith(CDATA_OPEN) && trimmed.endsWith(CDATA_CLOSE)
    ? {
        type: "html",
        html: trimmed.slice(CDATA_OPEN.length, -CDATA_CLOSE.length),
      }
    : { type: "text", text: value };
};

/** A despacho's text, whichever form it came in. */
export const parseBrTstDespacho = (
  value: string,
  identity: BrTstDocumentIdentity,
): Result<BrTstParsedDocument, BrTstParseError> => {
  const read = brTstDespachoTextOf(value);
  switch (read.type) {
    case "html":
      return parseBrTstHtml(read.html, identity);
    case "text": {
      const drafts = read.text.split(/\r?\n/u).flatMap((text): BlockDraft[] => {
        const line = lineOf([{ type: "text", text }]);
        return line === undefined ? [] : [{ style: undefined, line }];
      });
      return assemble(identity, numberedBlocks(drafts));
    }
    default:
      read satisfies never;
      return panic(`Unhandled TST despacho text: ${JSON.stringify(read)}`);
  }
};

/** The fields a súmula, OJ or precedente normativo is printed from. */
export type BrTstPrecedentText = {
  titulo: string | undefined;
  tese: string | undefined;
  observacao: string | undefined;
  historico: string | undefined;
};

/**
 * A precedent as the court prints it: the title as the heading, the thesis
 * one item per line, then the note on its current wording and its history,
 * which the court writes about the precedent rather than as part of it.
 * Each line is an HTML fragment, since the thesis marks cancelled items.
 */
export const parseBrTstPrecedent = (
  text: BrTstPrecedentText,
  identity: BrTstDocumentIdentity,
): Result<BrTstParsedDocument, BrTstParseError> => {
  const drafts: BlockDraft[] = [];
  const addLines = (
    value: string | undefined,
    style: ParagraphStyle | undefined,
  ): void => {
    for (const raw of (value ?? "").split(/\r?\n/u)) {
      const $ = cheerio.load(raw);
      const line = lineOf(walkInlines($, $("body")));
      if (line !== undefined) {
        drafts.push({ style, line });
      }
    }
  };
  addLines(text.titulo, { type: "heading", role: "decision-title" });
  addLines(text.tese, undefined);
  addLines(text.observacao, { type: "paragraph", role: "apparatus" });
  addLines(text.historico, { type: "paragraph", role: "apparatus" });
  return assemble(identity, numberedBlocks(drafts));
};
