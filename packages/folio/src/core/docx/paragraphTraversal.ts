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

type VisitDocxParagraphsInput = {
  documentBody: DocumentBody;
  headers?: Map<string, HeaderFooter> | undefined;
  footers?: Map<string, HeaderFooter> | undefined;
  footnotes?: readonly Footnote[] | undefined;
  endnotes?: readonly Endnote[] | undefined;
};

export const visitDocxParagraphs = (
  {
    documentBody,
    headers,
    footers,
    footnotes,
    endnotes,
  }: VisitDocxParagraphsInput,
  visit: (paragraph: Paragraph) => void,
): void => {
  const seenParagraphs = new WeakSet<Paragraph>();

  const visitParagraph = (paragraph: Paragraph): void => {
    if (seenParagraphs.has(paragraph)) {
      return;
    }
    seenParagraphs.add(paragraph);

    visit(paragraph);
    for (const content of paragraph.content) {
      visitParagraphContent(content);
    }
  };

  const visitRun = (run: Run): void => {
    for (const content of run.content) {
      if (content.type !== "shape" || !content.shape.textBody) {
        continue;
      }
      for (const paragraph of content.shape.textBody.content) {
        visitParagraph(paragraph);
      }
    }
  };

  const visitHyperlink = (hyperlink: Hyperlink): void => {
    for (const child of hyperlink.children) {
      if (child.type === "run") {
        visitRun(child);
      }
    }
  };

  const visitInlineContent = (content: readonly (Run | Hyperlink)[]): void => {
    for (const child of content) {
      if (child.type === "run") {
        visitRun(child);
        continue;
      }
      visitHyperlink(child);
    }
  };

  const visitParagraphContent = (content: ParagraphContent): void => {
    if (content.type === "run") {
      visitRun(content);
      return;
    }
    if (content.type === "hyperlink") {
      visitHyperlink(content);
      return;
    }
    if (
      content.type === "simpleField" ||
      content.type === "insertion" ||
      content.type === "deletion" ||
      content.type === "moveFrom" ||
      content.type === "moveTo"
    ) {
      visitInlineContent(content.content);
      return;
    }
    if (content.type === "inlineSdt") {
      // Inline SDT children include simple/complex fields, nested SDTs,
      // and math equations alongside runs/hyperlinks. Recurse through
      // the regular paragraph-content visitor so each child is dispatched
      // to its existing handler instead of being narrowed to Run|Hyperlink.
      for (const child of content.content) {
        visitParagraphContent(child);
      }
      return;
    }
    if (content.type === "complexField") {
      for (const run of content.fieldCode) {
        visitRun(run);
      }
      for (const run of content.fieldResult) {
        visitRun(run);
      }
    }
  };

  const visitTable = (table: Table): void => {
    for (const row of table.rows) {
      for (const cell of row.cells) {
        visitParagraphTableBlocks(cell.content);
      }
    }
  };

  const visitBlock = (block: BlockContent): void => {
    if (block.type === "paragraph") {
      visitParagraph(block);
      return;
    }
    if (block.type === "table") {
      visitTable(block);
      return;
    }
    visitParagraphTableBlocks(block.content);
  };

  const visitBlocks = (blocks: readonly BlockContent[]): void => {
    for (const block of blocks) {
      visitBlock(block);
    }
  };

  const visitParagraphTableBlocks = (
    blocks: readonly (Paragraph | Table)[],
  ): void => {
    for (const block of blocks) {
      if (block.type === "paragraph") {
        visitParagraph(block);
        continue;
      }
      visitTable(block);
    }
  };

  visitBlocks(documentBody.content);
  for (const section of documentBody.sections ?? []) {
    visitBlocks(section.content);
  }
  for (const header of headers?.values() ?? []) {
    visitParagraphTableBlocks(header.content);
  }
  for (const footer of footers?.values() ?? []) {
    visitParagraphTableBlocks(footer.content);
  }
  for (const footnote of footnotes ?? []) {
    visitParagraphTableBlocks(footnote.content);
  }
  for (const endnote of endnotes ?? []) {
    visitParagraphTableBlocks(endnote.content);
  }
  for (const comment of documentBody.comments ?? []) {
    for (const paragraph of comment.content) {
      visitParagraph(paragraph);
    }
  }
};
