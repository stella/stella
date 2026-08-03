import {
  compileLegalSourceToDocument,
  serializeDocumentToDocx,
} from "@stll/docx-core";
import type {
  BlockContent,
  Document,
  Paragraph,
  ParagraphContent,
  Run,
  Table,
  TableCell,
} from "@stll/docx-core";

const INLINE_BOLD_DELIMITER = "**";

const getInlineText = (run: Run): string | null => {
  const content = run.content.at(0);
  if (run.content.length !== 1 || content?.type !== "text") {
    return null;
  }
  return content.text;
};

const countInlineBoldDelimiters = (content: ParagraphContent[]): number => {
  let count = 0;
  for (const part of content) {
    if (part.type !== "run") {
      continue;
    }
    const text = getInlineText(part);
    if (text === null) {
      continue;
    }
    let cursor = 0;
    while (true) {
      const index = text.indexOf(INLINE_BOLD_DELIMITER, cursor);
      if (index === -1) {
        break;
      }
      count += 1;
      cursor = index + INLINE_BOLD_DELIMITER.length;
    }
  }
  return count;
};

/**
 * Legal-source headings have structural directives. A body paragraph wrapped
 * entirely in Markdown emphasis is almost always an accidental carry-over
 * from chat prose, especially in two-column bilingual drafts where it makes
 * a whole column look like a heading. Keep the readable text but drop the
 * delimiters rather than turning the complete body paragraph bold.
 */
const isWholeParagraphBold = ({
  content,
  delimiterCount,
}: {
  content: ParagraphContent[];
  delimiterCount: number;
}): boolean => {
  if (delimiterCount !== 2) {
    return false;
  }

  const text = content
    .flatMap((part) => (part.type === "run" ? [getInlineText(part) ?? ""] : []))
    .join("");
  const firstDelimiter = text.indexOf(INLINE_BOLD_DELIMITER);
  const lastDelimiter = text.lastIndexOf(INLINE_BOLD_DELIMITER);
  return (
    firstDelimiter !== -1 &&
    firstDelimiter !== lastDelimiter &&
    text.slice(0, firstDelimiter).trim().length === 0 &&
    text.slice(lastDelimiter + INLINE_BOLD_DELIMITER.length).trim().length === 0
  );
};

const appendInlineBoldRun = (
  runs: Run[],
  run: Run,
  text: string,
  bold: boolean,
) => {
  if (text.length === 0) {
    return;
  }
  const content = run.content.at(0);
  if (content?.type !== "text") {
    return;
  }
  runs.push({
    ...run,
    ...(bold
      ? {
          formatting: {
            ...run.formatting,
            bold: true,
            boldCs: true,
          },
        }
      : {}),
    content: [{ ...content, text }],
  });
};

const formatParagraphInlineBold = (paragraph: Paragraph): Paragraph => {
  const delimiterCount = countInlineBoldDelimiters(paragraph.content);
  if (delimiterCount < 2) {
    return paragraph;
  }

  const suppressWholeParagraphBold = isWholeParagraphBold({
    content: paragraph.content,
    delimiterCount,
  });
  const hasUnmatchedTrailingDelimiter = delimiterCount % 2 === 1;
  let remainingDelimiters = delimiterCount;
  let bold = false;
  const content: ParagraphContent[] = [];
  const runs: Run[] = [];
  for (const part of paragraph.content) {
    if (part.type !== "run") {
      content.push(part);
      continue;
    }
    const text = getInlineText(part);
    if (text === null) {
      content.push(part);
      continue;
    }

    runs.length = 0;
    let cursor = 0;
    while (true) {
      const delimiterIndex = text.indexOf(INLINE_BOLD_DELIMITER, cursor);
      if (delimiterIndex === -1) {
        appendInlineBoldRun(runs, part, text.slice(cursor), bold);
        break;
      }
      appendInlineBoldRun(runs, part, text.slice(cursor, delimiterIndex), bold);
      const isUnmatchedTrailingDelimiter =
        hasUnmatchedTrailingDelimiter && remainingDelimiters === 1;
      remainingDelimiters -= 1;
      if (isUnmatchedTrailingDelimiter) {
        appendInlineBoldRun(runs, part, INLINE_BOLD_DELIMITER, bold);
      } else {
        bold = suppressWholeParagraphBold ? false : !bold;
      }
      cursor = delimiterIndex + INLINE_BOLD_DELIMITER.length;
    }
    content.push(...runs);
  }
  return { ...paragraph, content };
};

const formatTableInlineBold = (table: Table): Table => {
  const formatCellBlock = (
    block: TableCell["content"][number],
  ): TableCell["content"][number] => {
    switch (block.type) {
      case "paragraph":
        return formatParagraphInlineBold(block);
      case "table":
        return formatTableInlineBold(block);
      default:
        block satisfies never;
        return block;
    }
  };

  return {
    ...table,
    rows: table.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => ({
        ...cell,
        content: cell.content.map((block) => formatCellBlock(block)),
      })),
    })),
  };
};

const formatBlockInlineBold = (block: BlockContent): BlockContent => {
  switch (block.type) {
    case "paragraph":
      return formatParagraphInlineBold(block);
    case "table":
      return formatTableInlineBold(block);
    case "blockSdt":
      return {
        ...block,
        content: block.content.map((child) => formatBlockInlineBold(child)),
      };
    default:
      block satisfies never;
      return block;
  }
};

const formatDocumentInlineBold = (document: Document): Document => ({
  ...document,
  package: {
    ...document.package,
    document: {
      ...document.package.document,
      content: document.package.document.content.map((block) =>
        formatBlockInlineBold(block),
      ),
      ...(document.package.document.sections === undefined
        ? {}
        : {
            sections: document.package.document.sections.map((section) => ({
              ...section,
              content: section.content.map((block) =>
                formatBlockInlineBold(block),
              ),
            })),
          }),
    },
  },
});

export const compileCreateDocumentSourceToDocument = (
  source: string,
  options?: Parameters<typeof compileLegalSourceToDocument>[1],
) => {
  const compiled = compileLegalSourceToDocument(source, options);
  if (compiled.status !== "ok") {
    return compiled;
  }
  return {
    ...compiled,
    document: formatDocumentInlineBold(compiled.document),
  };
};

export const compileCreateDocumentSourceToDocx = async (
  source: string,
  options?: Parameters<typeof compileLegalSourceToDocument>[1],
) => {
  const compiled = compileCreateDocumentSourceToDocument(source, options);
  if (compiled.status !== "ok") {
    return compiled;
  }
  return {
    ...compiled,
    buffer: await serializeDocumentToDocx(compiled.document, {
      language: compiled.draft.meta.locale,
    }),
  };
};
