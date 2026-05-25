import type {
  BlockContent,
  DocumentBody,
  Endnote,
  Footnote,
  HeaderFooter,
  Hyperlink,
  Paragraph,
  ParagraphContent,
  Run,
  Table,
} from "../types/document";
import type { NumberingMap } from "./numberingParser";

type NormalizeNumberingReferencesInput = {
  documentBody: DocumentBody;
  numbering: NumberingMap;
  headers?: Map<string, HeaderFooter>;
  footers?: Map<string, HeaderFooter>;
  footnotes?: readonly Footnote[];
  endnotes?: readonly Endnote[];
};

type NormalizeNumberingReferencesResult = {
  removedMissingNumberingReferences: number;
};

export const normalizeNumberingReferences = ({
  documentBody,
  numbering,
  headers,
  footers,
  footnotes,
  endnotes,
}: NormalizeNumberingReferencesInput): NormalizeNumberingReferencesResult => {
  const seenParagraphs = new WeakSet<Paragraph>();
  let removedMissingNumberingReferences = 0;

  const normalizeParagraph = (paragraph: Paragraph): void => {
    if (seenParagraphs.has(paragraph)) {
      return;
    }
    seenParagraphs.add(paragraph);

    const numId = paragraph.formatting?.numPr?.numId;
    if (numId !== undefined && numId !== 0 && !numbering.hasNumbering(numId)) {
      delete paragraph.formatting?.numPr;
      delete paragraph.listRendering;
      removedMissingNumberingReferences += 1;
    }

    for (const content of paragraph.content) {
      normalizeParagraphContent(content);
    }
  };

  const normalizeRun = (run: Run): void => {
    for (const content of run.content) {
      if (content.type === "shape" && content.shape.textBody) {
        for (const paragraph of content.shape.textBody.content) {
          normalizeParagraph(paragraph);
        }
      }
    }
  };

  const normalizeHyperlink = (hyperlink: Hyperlink): void => {
    for (const child of hyperlink.children) {
      if (child.type === "run") {
        normalizeRun(child);
      }
    }
  };

  const normalizeInlineContent = (
    content: readonly (Run | Hyperlink)[],
  ): void => {
    for (const child of content) {
      if (child.type === "run") {
        normalizeRun(child);
        continue;
      }
      normalizeHyperlink(child);
    }
  };

  const normalizeParagraphContent = (content: ParagraphContent): void => {
    if (content.type === "run") {
      normalizeRun(content);
      return;
    }
    if (content.type === "hyperlink") {
      normalizeHyperlink(content);
      return;
    }
    if (
      content.type === "simpleField" ||
      content.type === "inlineSdt" ||
      content.type === "insertion" ||
      content.type === "deletion" ||
      content.type === "moveFrom" ||
      content.type === "moveTo"
    ) {
      normalizeInlineContent(content.content);
      return;
    }
    if (content.type === "complexField") {
      for (const run of content.fieldCode) {
        normalizeRun(run);
      }
      for (const run of content.fieldResult) {
        normalizeRun(run);
      }
    }
  };

  const normalizeTable = (table: Table): void => {
    for (const row of table.rows) {
      for (const cell of row.cells) {
        normalizeParagraphTableBlocks(cell.content);
      }
    }
  };

  const normalizeBlock = (block: BlockContent): void => {
    if (block.type === "paragraph") {
      normalizeParagraph(block);
      return;
    }
    if (block.type === "table") {
      normalizeTable(block);
      return;
    }
    normalizeParagraphTableBlocks(block.content);
  };

  const normalizeBlocks = (blocks: readonly BlockContent[]): void => {
    for (const block of blocks) {
      normalizeBlock(block);
    }
  };

  const normalizeParagraphTableBlocks = (
    blocks: readonly (Paragraph | Table)[],
  ): void => {
    for (const block of blocks) {
      if (block.type === "paragraph") {
        normalizeParagraph(block);
        continue;
      }
      normalizeTable(block);
    }
  };

  normalizeBlocks(documentBody.content);
  for (const section of documentBody.sections ?? []) {
    normalizeBlocks(section.content);
  }
  for (const header of headers?.values() ?? []) {
    normalizeParagraphTableBlocks(header.content);
  }
  for (const footer of footers?.values() ?? []) {
    normalizeParagraphTableBlocks(footer.content);
  }
  for (const footnote of footnotes ?? []) {
    normalizeParagraphTableBlocks(footnote.content);
  }
  for (const endnote of endnotes ?? []) {
    normalizeParagraphTableBlocks(endnote.content);
  }
  for (const comment of documentBody.comments ?? []) {
    for (const paragraph of comment.content) {
      normalizeParagraph(paragraph);
    }
  }

  return { removedMissingNumberingReferences };
};
