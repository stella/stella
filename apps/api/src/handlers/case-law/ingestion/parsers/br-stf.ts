/**
 * Supremo Tribunal Federal decisions as documents.
 *
 * The publisher serves a decision's text inline in its search record, as
 * plain text, in one of two layouts that belong to the field rather than to
 * the decision:
 *
 * - `inteiro_teor_texto` (acórdãos) is the text layer of the signed PDF: a
 *   page break is a form feed, a blank line closes a printed block, and a
 *   single line break is a typeset line. A block is one paragraph and keeps
 *   its line breaks as `line-break` inlines.
 * - `decisao_texto` (decisões monocráticas) is the editor's text: every line
 *   is one paragraph.
 *
 * Neither layout is guessed from the text: the adapter names the field it
 * read, and the field names the layout. Nothing is split at sentences, and no
 * line is dropped; the running page headers and signature footers of the PDF
 * layer stay in the text as the paragraphs they print as (rule 10).
 *
 * Where the record carries no text, the PDF behind the record's document link
 * is read the way the ÚOHS adapter reads its PDFs.
 */

import { panic } from "better-result";

import type { Block, DocumentAst, Inline } from "@stll/legal-ast/document-ast";
import { plainTextOf } from "@stll/legal-ast/document-ast";

import {
  assemblePlSnParagraphs,
  extractPlPdfSeparatedContent,
  PL_PDF_PARAGRAPH_START,
} from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import type { PlSnRun } from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { courtParagraphNumbers } from "@/api/lib/legal-search/parsers/court-paragraph-numbers";

const BR_STF_SOURCE_SYSTEM = "jurisprudencia.stf.jus.br";
const BR_STF_LANGUAGE = "pt";

/** How a text field of the record lays out its paragraphs. */
export const BR_STF_TEXT_LAYOUT = {
  /** PDF text layer: blank lines and page breaks close a block. */
  PRINTED_BLOCKS: "printed-blocks",
  /** Editor text: one paragraph per line. */
  LINE_PARAGRAPHS: "line-paragraphs",
} as const;

export type BrStfTextLayout =
  (typeof BR_STF_TEXT_LAYOUT)[keyof typeof BR_STF_TEXT_LAYOUT];

/** The record's text fields, each with the layout it is published in. */
export const BR_STF_TEXT_FIELD_LAYOUTS = {
  inteiro_teor_texto: BR_STF_TEXT_LAYOUT.PRINTED_BLOCKS,
  decisao_texto: BR_STF_TEXT_LAYOUT.LINE_PARAGRAPHS,
} as const satisfies Record<string, BrStfTextLayout>;

export type BrStfTextField = keyof typeof BR_STF_TEXT_FIELD_LAYOUTS;

// A form feed is the page break the PDF text layer prints.
const PRINTED_BLOCK_BREAK = /\f|\n[ \t]*\n/u;

/**
 * The paragraphs a published text carries, each as the lines it prints.
 * Lines lose only the whitespace around them; empty lines and empty blocks
 * carry no text and separate paragraphs.
 */
export const brStfTextParagraphs = (
  text: string,
  layout: BrStfTextLayout,
): string[][] => {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const linesOf = (block: string) =>
    block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  switch (layout) {
    case BR_STF_TEXT_LAYOUT.PRINTED_BLOCKS:
      return normalized
        .split(PRINTED_BLOCK_BREAK)
        .map(linesOf)
        .filter((lines) => lines.length > 0);
    case BR_STF_TEXT_LAYOUT.LINE_PARAGRAPHS:
      return linesOf(normalized.replaceAll("\f", "\n")).map((line) => [line]);
    default:
      layout satisfies never;
      return panic(`Unhandled text layout: ${String(layout)}`);
  }
};

/** What a parsed decision states about itself beside its text. */
export type BrStfDocumentIdentity = {
  /** The record's own title ("ARE 1624555 AgR"), printed as the heading. */
  title: string | undefined;
  caseNumber: string;
  court: string;
  decisionDate: string | undefined;
  decisionType: string;
  sourceUrl: string;
  documentUrl: string | undefined;
};

export type BrStfParsedDocument = {
  documentAst: DocumentAst;
  fulltext: string;
};

type BrStfParagraph = {
  inlines: Inline[];
  note?: { type: "footnote"; label: string; noteId: string } | undefined;
};

const linesInlines = (lines: readonly string[]): Inline[] =>
  lines.flatMap((line, index): Inline[] =>
    index === 0
      ? [{ type: "text", text: line }]
      : [{ type: "line-break" }, { type: "text", text: line }],
  );

const runsInlines = (runs: readonly PlSnRun[]): Inline[] =>
  runs.map(({ text, bold, footnoteReference }): Inline => {
    if (footnoteReference !== undefined) {
      return {
        type: "link",
        href: `#footnote-${footnoteReference}`,
        children: [{ type: "superscript", children: [{ type: "text", text }] }],
      };
    }
    return bold
      ? { type: "bold", children: [{ type: "text", text }] }
      : { type: "text", text };
  });

/**
 * The decision as a document: the record's title as its heading, then one
 * paragraph block per published paragraph, with the court's own "N." numbering
 * moved into the block by the shared reader.
 */
const brStfDocumentAst = (
  identity: BrStfDocumentIdentity,
  paragraphs: readonly BrStfParagraph[],
): DocumentAst => {
  const subject = {
    parser: ADAPTER_KEYS.BR_STF,
    caseNumber: identity.caseNumber,
    language: BR_STF_LANGUAGE,
    url: identity.sourceUrl,
  };
  const body: Block[] = paragraphs.map(({ inlines, note }, index) => ({
    id: `b${index + 1}`,
    anchorId: note?.noteId ?? `p-${index + 1}`,
    type: "paragraph",
    ...(note === undefined ? {} : { note }),
    inlines,
    plainText: plainTextOf(inlines).trim(),
  }));
  const title = identity.title?.trim();
  const heading: Block[] =
    title === undefined || title.length === 0
      ? []
      : [
          {
            id: "h1",
            anchorId: "title",
            type: "heading",
            level: 1,
            role: "decision-title",
            inlines: [{ type: "text", text: title }],
            plainText: title,
          },
        ];
  const blocks = [...heading, ...body];
  return {
    version: 1,
    source: {
      system: BR_STF_SOURCE_SYSTEM,
      documentId: identity.sourceUrl,
      webUrl: identity.sourceUrl,
      printUrl: identity.documentUrl ?? "",
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
    blocks: courtParagraphNumbers(blocks, subject),
  };
};

/** A decision text the record carries inline, read in its field's layout. */
export const parseBrStfText = (
  text: string,
  field: BrStfTextField,
  identity: BrStfDocumentIdentity,
): BrStfParsedDocument => {
  const paragraphs = brStfTextParagraphs(
    text,
    BR_STF_TEXT_FIELD_LAYOUTS[field],
  );
  return {
    documentAst: brStfDocumentAst(
      identity,
      paragraphs.map((lines) => ({ inlines: linesInlines(lines) })),
    ),
    fulltext: paragraphs.map((lines) => lines.join("\n")).join("\n\n"),
  };
};

/**
 * A decision PDF, read as the ÚOHS adapter reads its own: typeset lines joined
 * back into the paragraphs the layout breaks them from, footnotes linked.
 */
export const parseBrStfPdf = async (
  bytes: Uint8Array,
  identity: BrStfDocumentIdentity,
): Promise<BrStfParsedDocument> => {
  const { body, notes } = await extractPlPdfSeparatedContent(
    bytes,
    PL_PDF_PARAGRAPH_START.INDENT_OR_OUTDENT,
  );
  const noteGroups = new Map<
    string,
    { label: string; noteId: string; lines: typeof notes }
  >();
  for (const line of notes) {
    if (line.type !== "text" || line.footnote === undefined) {
      continue;
    }
    const group = noteGroups.get(line.footnote.noteId) ?? {
      ...line.footnote,
      lines: [],
    };
    group.lines.push(line);
    noteGroups.set(line.footnote.noteId, group);
  }
  const paragraphs: BrStfParagraph[] = [
    ...assemblePlSnParagraphs(body).map((runs) => ({
      inlines: runsInlines(runs),
    })),
    ...[...noteGroups.values()].map(({ label, noteId, lines }) => ({
      inlines: runsInlines(assemblePlSnParagraphs(lines).flat()),
      note: { type: "footnote" as const, label, noteId },
    })),
  ];
  return {
    documentAst: brStfDocumentAst(identity, paragraphs),
    // The notes are the court's text as much as the body is, so search reads
    // them too, after the body as the document prints them.
    fulltext: [body, notes]
      .map((lines) =>
        lines
          .map((line) =>
            line.type === "blank"
              ? ""
              : line.runs.map(({ text }) => text).join(""),
          )
          .join("\n")
          .trim(),
      )
      .filter((text) => text.length > 0)
      .join("\n\n"),
  };
};
