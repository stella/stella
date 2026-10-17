import { Result } from "better-result";
import * as cheerio from "cheerio";
import { hasChildren, isTag, isText, type AnyNode } from "domhandler";

import {
  type Block,
  type GuidanceDocumentAst,
  type HeadingLevel,
  type Inline,
  type ParagraphListDepth,
  type ParagraphNote,
  type TableCell,
  type TableBlock,
  projectPlainText,
  plainTextOf,
} from "@stll/legal-ast/document-ast";
import {
  normalizeInlineLine,
  stripInlinePrefix,
} from "@stll/legal-ast/inline-line";
import type { SoftLawKind } from "@stll/legal-ast/soft-law";

import {
  isExcludedHtmlTag,
  ownTableRows,
  walkInlines,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";
import {
  assemblePdfParagraphs,
  extractPdfParagraphLines,
  type PdfParagraphLine,
} from "@/api/lib/legal-search/parsers/pdf-paragraphs";
import { sanitizeUrl } from "@/api/lib/sanitize-url";

import type { SoftLawAuthority, SoftLawDocumentInput } from "./soft-law-types";

export const SOFT_LAW_AST_BUILDER_VERSION = 1;

type GuidanceLayout =
  | "numbered-paragraphs"
  | "sections"
  | "questions-and-answers";
export const GUIDANCE_LAYOUTS = {
  methodology: "sections",
  recommendation: "numbered-paragraphs",
  opinion: "numbered-paragraphs",
  faq: "questions-and-answers",
  guideline: "numbered-paragraphs",
  position: "sections",
  statement: "sections",
  inspection_report: "sections",
  annual_report: "sections",
  other: "sections",
} as const satisfies Record<SoftLawKind, GuidanceLayout>;

export type SoftLawOriginalOnlyReason =
  | "needs_ocr"
  | "extraction_failed"
  | "scanned_ocr_without_text"
  | "empty_document"
  | "document_raw_unavailable"
  | "unsupported_format";
export type SoftLawAstReaderState =
  | {
      type: "readable";
      documentAst: GuidanceDocumentAst;
      astBuilderVersion: number;
    }
  | {
      type: "original-only";
      reason: SoftLawOriginalOnlyReason;
      astBuilderVersion: number;
    };

const originalOnly = (
  reason: SoftLawOriginalOnlyReason,
): SoftLawAstReaderState => ({
  type: "original-only",
  reason,
  astBuilderVersion: SOFT_LAW_AST_BUILDER_VERSION,
});

const NUMBERED_PARAGRAPH = /^\s*(\d{1,6})[.)]\s+/u;
const LIST_MARKER = /^\s*(?:[-–•]|[a-z][.)])\s+/u;
const headingLevel = (tag: string): HeadingLevel | undefined => {
  switch (tag) {
    case "h1":
      return 1;
    case "h2":
      return 2;
    case "h3":
      return 3;
    case "h4":
      return 4;
    case "h5":
      return 5;
    case "h6":
      return 6;
    default:
      return undefined;
  }
};
const nestedDepth = (
  depth: ParagraphListDepth | undefined,
): ParagraphListDepth => {
  switch (depth) {
    case undefined:
      return 1;
    case 1:
      return 2;
    case 2:
      return 3;
    case 3:
    case 4:
      return 4;
  }
};

type HtmlTableOptions = {
  $: cheerio.CheerioAPI;
  node: AnyNode;
  note?: ParagraphNote | undefined;
  id: string;
};
const htmlTableBlock = ({
  $,
  node,
  note,
  id,
}: HtmlTableOptions): TableBlock | undefined => {
  const rows: TableCell[][] = [];
  ownTableRows($(node)).each((_rowIndex, row) => {
    const cells: TableCell[] = [];
    $(row)
      .children("th, td")
      .each((_cellIndex, cell) => {
        const inlines = walkInlines($, $(cell), {
          sanitizeHref: sanitizeUrl,
          parseSpanStyle: true,
        });
        const colSpan = Number($(cell).attr("colspan"));
        const rowSpan = Number($(cell).attr("rowspan"));
        cells.push({
          inlines,
          plainText: projectPlainText(inlines),
          ...(Number.isSafeInteger(colSpan) && colSpan > 1 ? { colSpan } : {}),
          ...(Number.isSafeInteger(rowSpan) && rowSpan > 1 ? { rowSpan } : {}),
          ...(cell.name === "th" ? { header: true as const } : {}),
        });
      });
    if (cells.length > 0) {
      rows.push(cells);
    }
  });
  if (rows.length > 0) {
    return {
      type: "table",
      id,
      anchorId: id,
      rows,
      plainText: rows
        .map((row) => row.map((cell) => cell.plainText).join("\t"))
        .join("\n"),
      ...(note === undefined ? {} : { note }),
    };
  }
  return undefined;
};

/** Shared format builder: publisher identity never selects a structural parser. */
const htmlBlocks = (html: string, layout: GuidanceLayout): Block[] => {
  const $ = cheerio.load(html);
  const blocks: Block[] = [];
  const inlinesOf = (node: AnyNode) =>
    walkInlines($, $(node), {
      sanitizeHref: sanitizeUrl,
      parseSpanStyle: true,
    });
  type AppendOptions = {
    inlines: Inline[];
    level?: HeadingLevel | undefined;
    listDepth?: ParagraphListDepth | undefined;
    note?: ParagraphNote | undefined;
  };
  const append = ({ inlines, level, listDepth, note }: AppendOptions) => {
    const normalized = normalizeInlineLine(inlines).inlines;
    const text = plainTextOf(normalized);
    const match =
      layout === "numbered-paragraphs" &&
      level === undefined &&
      note === undefined &&
      listDepth === undefined
        ? NUMBERED_PARAGRAPH.exec(text)
        : null;
    const number = match?.at(1);
    const content =
      match === null
        ? normalized
        : stripInlinePrefix(normalized, match[0].length);
    const plainText = projectPlainText(content);
    if (!plainText) {
      return;
    }
    const id = `guidance-${blocks.length + 1}`;
    if (
      note === undefined &&
      (level !== undefined ||
        (layout === "questions-and-answers" && plainText.endsWith("?")))
    ) {
      blocks.push({
        type: "heading",
        id,
        anchorId: id,
        level: level ?? 2,
        inlines: content,
        plainText,
      });
      return;
    }
    blocks.push({
      type: "paragraph",
      id,
      anchorId: id,
      inlines: content,
      plainText,
      ...(number === undefined ? {} : { number: Number(number) }),
      ...(listDepth === undefined ? {} : { listDepth }),
      ...(note === undefined ? {} : { note }),
    });
  };
  type WalkOptions = {
    listDepth?: ParagraphListDepth | undefined;
    note?: ParagraphNote | undefined;
    marker?: string | undefined;
  };
  type WalkListOptions = WalkOptions & { tag: "ul" | "ol" };
  const walkList = (
    node: AnyNode,
    { tag, listDepth, note }: WalkListOptions,
  ): void => {
    if (!hasChildren(node)) {
      return;
    }
    const element = $(node);
    let value = Number(element.attr("start") ?? 1);
    if (!Number.isSafeInteger(value)) {
      value = 1;
    }
    for (const child of node.children) {
      if (!isTag(child) || child.name !== "li") {
        continue;
      }
      const statedValue = Number($(child).attr("value"));
      if (
        $(child).attr("value") !== undefined &&
        Number.isSafeInteger(statedValue)
      ) {
        value = statedValue;
      }
      walk(child, {
        listDepth: nestedDepth(listDepth),
        note,
        marker: tag === "ol" ? `${value}. ` : "• ",
      });
      value += 1;
    }
  };
  const walk = (
    node: AnyNode,
    { listDepth, note: inheritedNote, marker }: WalkOptions = {},
  ): void => {
    if (!hasChildren(node) || (isTag(node) && isExcludedHtmlTag(node.name))) {
      return;
    }
    const tag = isTag(node) ? node.name.toLowerCase() : "";
    const element = $(node);
    const noteLabel =
      element.attr("data-footnote-label") ??
      /^(?:fn|footnote)[-_]?(\d+)$/iu.exec(element.attr("id") ?? "")?.at(1);
    const note: ParagraphNote | undefined =
      noteLabel === undefined
        ? inheritedNote
        : {
            type: "footnote",
            label: noteLabel,
            noteId: element.attr("id") ?? `html-note-${blocks.length + 1}`,
          };
    if (tag === "table") {
      const table = htmlTableBlock({
        $,
        node,
        note,
        id: `guidance-${blocks.length + 1}`,
      });
      if (table !== undefined) {
        blocks.push(table);
      }
      return;
    }
    if (tag === "ul" || tag === "ol") {
      walkList(node, { tag, listDepth, note });
      return;
    }
    const level = headingLevel(tag);
    if (level !== undefined || tag === "p" || tag === "dt" || tag === "dd") {
      append({
        inlines: inlinesOf(node),
        level: level ?? (tag === "dt" ? 2 : undefined),
        listDepth,
        note,
      });
      return;
    }
    // Flush only adjacent inline content; nested lists and tables keep their own blocks.
    const firstBlockIndex = blocks.length;
    let inlineNodes: AnyNode[] = [];
    const flush = () => {
      if (inlineNodes.length === 0) {
        return;
      }
      const wrapper = $("<div></div>");
      for (const child of inlineNodes) {
        wrapper.append($(child).clone());
      }
      const inlines = walkInlines($, wrapper, {
        sanitizeHref: sanitizeUrl,
        parseSpanStyle: true,
      });
      append({ inlines, listDepth, note });
      inlineNodes = [];
    };
    for (const child of node.children) {
      if (
        isTag(child) &&
        (headingLevel(child.name) !== undefined ||
          [
            "p",
            "div",
            "section",
            "article",
            "main",
            "table",
            "ul",
            "ol",
            "li",
            "dl",
            "dt",
            "dd",
            "aside",
          ].includes(child.name))
      ) {
        flush();
        walk(child, { listDepth, note });
      } else if (isText(child) || isTag(child)) {
        inlineNodes.push(child);
      }
    }
    flush();
    const firstBlock = blocks.at(firstBlockIndex);
    if (marker !== undefined && firstBlock?.type === "paragraph") {
      firstBlock.inlines.unshift({ type: "text", text: marker });
      firstBlock.plainText = projectPlainText(firstBlock.inlines);
    }
  };
  const root = $("main").first();
  const content = root.length > 0 ? root : $("body");
  for (const node of content.toArray()) {
    walk(node);
  }
  return blocks;
};

const pdfTextBlocks = (
  lines: readonly PdfParagraphLine[],
  layout: GuidanceLayout,
): Block[] => {
  const structured: PdfParagraphLine[] = [];
  let afterHeading = false;
  for (const line of lines) {
    if (line.type === "blank") {
      structured.push(line);
      afterHeading = false;
      continue;
    }
    const text = line.runs
      .map((run) => run.text)
      .join("")
      .trim();
    const heading =
      line.note === undefined &&
      ((layout === "questions-and-answers" && text.endsWith("?")) ||
        line.runs.every((run) => run.bold));
    if (heading || afterHeading) {
      structured.push({ type: "blank" });
    }
    structured.push({
      ...line,
      indented:
        line.indented ||
        heading ||
        (line.note === undefined &&
          (NUMBERED_PARAGRAPH.test(text) || LIST_MARKER.test(text))),
    });
    afterHeading = heading;
  }
  let blocksCounter = 1;
  return assemblePdfParagraphs(structured).flatMap(
    ({ runs, note }): Block[] => {
      const inlines: Inline[] = runs.map(({ text, bold }) =>
        bold
          ? { type: "bold", children: [{ type: "text", text }] }
          : { type: "text", text },
      );
      const plainText = projectPlainText(inlines);
      if (!plainText) {
        return [];
      }
      const id = `guidance-${blocksCounter++}`;
      const heading =
        note === undefined &&
        ((layout === "questions-and-answers" && plainText.endsWith("?")) ||
          runs.every((run) => run.bold));
      if (heading) {
        return [
          { type: "heading", id, anchorId: id, level: 2, inlines, plainText },
        ];
      }
      const match =
        note === undefined && layout === "numbered-paragraphs"
          ? NUMBERED_PARAGRAPH.exec(plainTextOf(inlines))
          : null;
      const number = match?.at(1);
      const content =
        match === null ? inlines : stripInlinePrefix(inlines, match[0].length);
      return [
        {
          type: "paragraph",
          id,
          anchorId: id,
          inlines: content,
          plainText: projectPlainText(content),
          ...(number === undefined ? {} : { number: Number(number) }),
          ...(LIST_MARKER.test(plainText) ? { listDepth: 1 } : {}),
          ...(note === undefined ? {} : { note }),
        },
      ];
    },
  );
};

/** Explicit printed delimiters prove a grid; aligned prose alone does not. */
const pdfBlocks = (
  lines: readonly PdfParagraphLine[],
  layout: GuidanceLayout,
): Block[] => {
  const blocks: Block[] = [];
  let prose: PdfParagraphLine[] = [];
  let tableLines: Extract<PdfParagraphLine, { type: "text" }>[] = [];
  const flushTable = () => {
    if (tableLines.length < 2) {
      prose.push(...tableLines);
      tableLines = [];
      return;
    }
    blocks.push(...pdfTextBlocks(prose, layout));
    prose = [];
    const rows = tableLines.map((line) => {
      const text = line.runs.map((run) => run.text).join("");
      const separators = [...text.matchAll(/\|/gu)].map((match) => match.index);
      const cells: TableCell[] = [];
      for (let index = 1; index < separators.length; index += 1) {
        const start = separators.at(index - 1);
        const end = separators.at(index);
        if (start === undefined || end === undefined) {
          continue;
        }
        const inlines: Inline[] = [];
        let offset = 0;
        for (const run of line.runs) {
          const from = Math.max(start + 1 - offset, 0);
          const to = Math.min(end - offset, run.text.length);
          const part = from < to ? run.text.slice(from, to) : "";
          if (part) {
            inlines.push(
              run.bold
                ? { type: "bold", children: [{ type: "text", text: part }] }
                : { type: "text", text: part },
            );
          }
          offset += run.text.length;
        }
        cells.push({ inlines, plainText: projectPlainText(inlines) });
      }
      return cells;
    });
    const id = `guidance-${blocks.length + 1}`;
    const note = tableLines.at(0)?.note;
    blocks.push({
      type: "table",
      id,
      anchorId: id,
      rows,
      plainText: rows
        .map((row) => row.map((cell) => cell.plainText).join("\t"))
        .join("\n"),
      ...(note === undefined ? {} : { note }),
    });
    tableLines = [];
  };
  for (const line of lines) {
    if (
      line.type === "text" &&
      /^\s*\|[^|]+\|.+\|\s*$/u.test(line.runs.map((run) => run.text).join(""))
    ) {
      const previous = tableLines.at(-1);
      if (
        previous !== undefined &&
        (previous.note?.noteId !== line.note?.noteId ||
          previous.source?.pageIndex !== line.source?.pageIndex)
      ) {
        flushTable();
      }
      tableLines.push(line);
      continue;
    }
    flushTable();
    prose.push(line);
  }
  flushTable();
  blocks.push(...pdfTextBlocks(prose, layout));
  return blocks;
};

const namespaceNote = (block: Block, originalIndex: number): Block => {
  if (
    (block.type !== "paragraph" && block.type !== "table") ||
    block.note?.noteId === undefined
  ) {
    return block;
  }
  return {
    ...block,
    note: {
      type: "footnote",
      label: block.note.label,
      noteId: `document-${originalIndex}-${block.note.noteId}`,
    },
  };
};

type BuildSoftLawAstOptions = {
  authority: SoftLawAuthority;
  documentId: string;
  sourceUrl: string;
  input: SoftLawDocumentInput;
};

/** Rebuild solely from the retained document, never its discovery/listing pages. */
export const buildSoftLawAst = async ({
  authority,
  documentId,
  sourceUrl,
  input,
}: BuildSoftLawAstOptions): Promise<SoftLawAstReaderState> => {
  if (input.extractionQuality === "needs_ocr") {
    return originalOnly("needs_ocr");
  }
  if (input.extractionQuality === "extraction_failed") {
    return originalOnly("extraction_failed");
  }
  if (input.extractionQuality === "scanned_ocr" && !input.text?.trim()) {
    return originalOnly("scanned_ocr_without_text");
  }
  const layout = GUIDANCE_LAYOUTS[input.metadata.kind];
  let blocks: Block[] = [];
  if (input.extractionQuality === "scanned_ocr") {
    const lines: PdfParagraphLine[] = (input.text ?? "")
      .split(/\r?\n/u)
      .map((text) =>
        text.trim()
          ? { type: "text", indented: false, runs: [{ text, bold: false }] }
          : { type: "blank" },
      );
    blocks = pdfBlocks(lines, layout);
  } else {
    const originals = input.raw.filter(
      (part) =>
        part.purpose === "document" ||
        (part.purpose === undefined &&
          (part.role === "document" || part.role === "page")),
    );
    if (originals.length === 0) {
      return originalOnly("document_raw_unavailable");
    }
    for (const [originalIndex, original] of originals.entries()) {
      const contentType = original.contentType
        .split(";")
        .at(0)
        ?.trim()
        .toLowerCase();
      if (
        contentType === "text/html" ||
        contentType === "application/xhtml+xml"
      ) {
        blocks.push(
          ...htmlBlocks(new TextDecoder().decode(original.bytes), layout),
        );
      } else if (
        contentType === "application/pdf" ||
        (contentType === "application/octet-stream" &&
          new TextDecoder().decode(original.bytes.subarray(0, 5)) === "%PDF-")
      ) {
        const extraction = await Result.tryPromise(async () =>
          pdfBlocks(
            await extractPdfParagraphLines(original.bytes, {
              footnotes: "detect",
            }),
            layout,
          ),
        );
        if (extraction.isErr()) {
          return originalOnly("extraction_failed");
        }
        blocks.push(
          ...extraction.value.map((block) =>
            namespaceNote(block, originalIndex),
          ),
        );
      } else {
        return originalOnly("unsupported_format");
      }
    }
  }
  if (!blocks.some((block) => block.plainText.trim().length > 0)) {
    return originalOnly("empty_document");
  }
  // A document can retain several attachments; identities span their combined reading order.
  blocks = blocks.map((block, index) => ({
    ...block,
    id: `guidance-${index + 1}`,
    anchorId: `guidance-${index + 1}`,
  }));
  const expression = input.metadata.expression ?? { type: "unspecified" };
  return {
    type: "readable",
    astBuilderVersion: SOFT_LAW_AST_BUILDER_VERSION,
    documentAst: {
      version: 1,
      source: {
        system: authority,
        documentId,
        webUrl: sourceUrl,
        printUrl: sourceUrl,
      },
      metadata: {
        family: "guidance",
        authority,
        kind: input.metadata.kind,
        statedReference: input.metadata.statedReference,
        issuedOn: input.metadata.issuedOn,
        expression,
        language:
          expression.type === "identified"
            ? { state: "stated", value: expression.language }
            : { state: "not_stated" },
        validityState: input.metadata.validity.state,
      },
      blocks,
    },
  };
};
