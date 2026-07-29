import type {
  BlockContent,
  Footnote,
  Hyperlink,
  Paragraph,
  ParagraphContent,
  Run,
  Table,
} from "@stll/docx-core/model";
import type { Document } from "@stll/folio-core";

import type { ChatExportCitationStyle } from "@/api/handlers/chat/export/citation-footnotes";
import { unreachable } from "@/api/lib/errors/tagged-errors";

const FOLIO_CITATION_PREFIX = "#folio:";
const DECISION_CITATION_PREFIX = "#stella-decision=";

const isCitationHyperlink = ({ href }: Hyperlink): boolean => {
  if (href === undefined) {
    return false;
  }
  return (
    href.startsWith("https://") ||
    href.startsWith("http://") ||
    href.startsWith(FOLIO_CITATION_PREFIX) ||
    href.startsWith(DECISION_CITATION_PREFIX)
  );
};

const citationTarget = ({ anchor, href }: Hyperlink): string =>
  href ?? (anchor === undefined ? "" : `#${anchor}`);

const hyperlinkVisibleText = ({ children }: Hyperlink): string => {
  const fragments: string[] = [];
  for (const child of children) {
    if (child.type !== "run") {
      continue;
    }
    for (const content of child.content) {
      if (content.type === "text") {
        fragments.push(content.text);
      } else if (content.type === "tab") {
        fragments.push(" ");
      }
    }
  }
  return fragments.join("").trim().replace(/\s+/gu, " ");
};

const createFootnoteReference = (id: number): Run => ({
  type: "run",
  content: [{ type: "footnoteRef", id }],
});

const createFootnote = (id: number, target: string): Footnote => ({
  type: "footnote",
  id,
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "run",
          content: [{ type: "text", text: target }],
        },
      ],
    },
  ],
});

type CitationTransformContext = {
  footnoteByTarget: Map<string, number>;
  footnotes: Footnote[];
  folioSourceTitle: string | undefined;
  internalCitationFallback: string;
  nextFootnoteId: number;
  style: Exclude<ChatExportCitationStyle, "inline">;
};

const citationFootnoteText = (
  hyperlink: Hyperlink,
  context: CitationTransformContext,
): string => {
  const target = citationTarget(hyperlink);
  if (
    !target.startsWith(FOLIO_CITATION_PREFIX) &&
    !target.startsWith(DECISION_CITATION_PREFIX)
  ) {
    return target;
  }

  const visibleText = hyperlinkVisibleText(hyperlink);
  if (
    target.startsWith(FOLIO_CITATION_PREFIX) &&
    context.folioSourceTitle !== undefined
  ) {
    if (visibleText.length === 0) {
      return context.folioSourceTitle;
    }
    return `${context.folioSourceTitle}: ${visibleText}`;
  }
  return visibleText || context.internalCitationFallback;
};

const transformHyperlink = (
  hyperlink: Hyperlink,
  context: CitationTransformContext,
): ParagraphContent[] => {
  if (!isCitationHyperlink(hyperlink)) {
    return [hyperlink];
  }
  if (context.style === "none") {
    return hyperlink.children;
  }

  const target = citationTarget(hyperlink);
  const existingId = context.footnoteByTarget.get(target);
  if (existingId !== undefined) {
    return [...hyperlink.children, createFootnoteReference(existingId)];
  }

  const id = context.nextFootnoteId;
  context.nextFootnoteId += 1;
  context.footnoteByTarget.set(target, id);
  context.footnotes.push(
    createFootnote(id, citationFootnoteText(hyperlink, context)),
  );
  return [...hyperlink.children, createFootnoteReference(id)];
};

const transformParagraph = (
  paragraph: Paragraph,
  context: CitationTransformContext,
): Paragraph => {
  const content: ParagraphContent[] = [];
  for (const item of paragraph.content) {
    if (item.type === "hyperlink") {
      content.push(...transformHyperlink(item, context));
      continue;
    }
    content.push(item);
  }
  return { ...paragraph, content };
};

const transformTable = (
  table: Table,
  context: CitationTransformContext,
): Table => ({
  ...table,
  rows: table.rows.map((row) => ({
    ...row,
    cells: row.cells.map((cell) => ({
      ...cell,
      content: cell.content.map((block) => {
        switch (block.type) {
          case "paragraph":
            return transformParagraph(block, context);
          case "table":
            return transformTable(block, context);
          default:
            return unreachable(
              `Unhandled table-cell block: ${JSON.stringify(block)}`,
            );
        }
      }),
    })),
  })),
});

const transformBlock = (
  block: BlockContent,
  context: CitationTransformContext,
): BlockContent => {
  switch (block.type) {
    case "paragraph":
      return transformParagraph(block, context);
    case "table":
      return transformTable(block, context);
    case "blockSdt":
      return {
        ...block,
        content: block.content.map((child) => transformBlock(child, context)),
      };
    default:
      return unreachable(`Unhandled document block: ${JSON.stringify(block)}`);
  }
};

const nextFootnoteId = (footnotes: readonly Footnote[]): number => {
  let maximumId = 0;
  for (const footnote of footnotes) {
    maximumId = Math.max(maximumId, footnote.id);
  }
  return maximumId + 1;
};

/**
 * Apply a citation presentation to a newly parsed export document.
 *
 * Normal Stella references are not citations and remain hyperlinks. Citation
 * hyperlinks are either preserved inline, unwrapped without losing their
 * visible text, or converted to real, destination-deduplicated Word footnotes.
 */
export const styleDocumentCitations = (
  document: Document,
  style: ChatExportCitationStyle,
  {
    folioSourceTitle,
    internalCitationFallback,
  }: {
    folioSourceTitle: string | undefined;
    internalCitationFallback: string;
  },
): Document => {
  if (style === "inline") {
    return document;
  }

  const footnotes: Footnote[] = [];
  const existingFootnotes = document.package.footnotes;
  if (existingFootnotes !== undefined) {
    footnotes.push(...existingFootnotes);
  }
  const context: CitationTransformContext = {
    footnoteByTarget: new Map(),
    footnotes,
    folioSourceTitle,
    internalCitationFallback,
    nextFootnoteId: nextFootnoteId(footnotes),
    style,
  };
  const content = document.package.document.content.map((block) =>
    transformBlock(block, context),
  );

  return {
    ...document,
    package: {
      ...document.package,
      document: {
        ...document.package.document,
        content,
      },
      footnotes: context.footnotes,
    },
  };
};
