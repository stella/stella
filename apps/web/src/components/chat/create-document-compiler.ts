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

type InlineTextSegment = {
  bold: boolean;
  text: string;
};

const INLINE_BOLD_PATTERN = /\*\*([^*]+)\*\*/gu;

const splitInlineBold = (text: string): InlineTextSegment[] | null => {
  const segments: InlineTextSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE_BOLD_PATTERN)) {
    const index = match.index;
    const boldText = match.at(1);
    if (boldText === undefined) {
      continue;
    }
    if (index > cursor) {
      segments.push({ bold: false, text: text.slice(cursor, index) });
    }
    segments.push({ bold: true, text: boldText });
    cursor = index + match[0].length;
  }

  if (segments.length === 0) {
    return null;
  }
  if (cursor < text.length) {
    segments.push({ bold: false, text: text.slice(cursor) });
  }
  return segments;
};

const expandInlineBoldRun = (run: Run): Run[] => {
  const content = run.content.at(0);
  if (run.content.length !== 1 || content?.type !== "text") {
    return [run];
  }

  const segments = splitInlineBold(content.text);
  if (segments === null) {
    return [run];
  }

  const runs: Run[] = [];
  for (const segment of segments) {
    runs.push({
      ...run,
      ...(segment.bold
        ? {
            formatting: {
              ...run.formatting,
              bold: true,
              boldCs: true,
            },
          }
        : {}),
      content: [{ ...content, text: segment.text }],
    });
  }
  return runs;
};

const formatParagraphInlineBold = (paragraph: Paragraph): Paragraph => {
  const content: ParagraphContent[] = [];
  for (const part of paragraph.content) {
    if (part.type === "run") {
      content.push(...expandInlineBoldRun(part));
      continue;
    }
    content.push(part);
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
