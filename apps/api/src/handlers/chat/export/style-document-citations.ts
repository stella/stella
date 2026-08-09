import {
  CHAT_RESOURCE_HREF_PREFIX,
  EMAIL_CITATION_HREF_PREFIX,
  parseEmailCitationHref,
} from "@stll/api-contract";
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
const SEARCH_SUMMARY_CITATION_TARGET_PREFIX = "#stella-search-summary=";
const SEARCH_SUMMARY_CITATION_MARKER = /\[(?<number>[1-9]\d*)\]/gu;
const SEARCH_SUMMARY_SOURCE_NUMBER = /^\[(?<number>[1-9]\d*)\]/u;

type InternalReferenceMode =
  | "references"
  | "unverified-citations"
  | "verified-citations";

const isCitationHyperlink = (
  { href }: Hyperlink,
  internalReferenceMode: InternalReferenceMode,
): boolean => {
  if (href === undefined) {
    return false;
  }
  return (
    href.startsWith("https://") ||
    href.startsWith("http://") ||
    href.startsWith(FOLIO_CITATION_PREFIX) ||
    parseEmailCitationHref(href) !== null ||
    href.startsWith(CHAT_RESOURCE_HREF_PREFIX.case_law_decision) ||
    (internalReferenceMode !== "references" &&
      (href.startsWith(CHAT_RESOURCE_HREF_PREFIX.entity) ||
        href.startsWith(CHAT_RESOURCE_HREF_PREFIX.workspace)))
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
  internalReferenceMode: InternalReferenceMode;
  nextFootnoteId: number;
  style: ChatExportCitationStyle;
  unverifiedCitationLabel: string;
  verifiedCitationCount: number;
  unverifiedCitationCount: number;
  trustedSearchSummaryCitationByNumber: ReadonlyMap<number, string>;
};

const isVerifiedSearchSummaryTarget = (
  target: string,
  internalReferenceMode: InternalReferenceMode,
): boolean =>
  internalReferenceMode === "verified-citations" &&
  (target.startsWith(CHAT_RESOURCE_HREF_PREFIX.case_law_decision) ||
    target.startsWith(CHAT_RESOURCE_HREF_PREFIX.entity) ||
    target.startsWith(CHAT_RESOURCE_HREF_PREFIX.workspace));

const citationFootnoteText = (
  hyperlink: Hyperlink,
  context: CitationTransformContext,
): string => {
  const target = citationTarget(hyperlink);
  const visibleText = hyperlinkVisibleText(hyperlink);
  if (isVerifiedSearchSummaryTarget(target, context.internalReferenceMode)) {
    return visibleText || context.internalCitationFallback;
  }

  let description = visibleText || context.internalCitationFallback;
  if (
    target.startsWith(FOLIO_CITATION_PREFIX) &&
    context.folioSourceTitle !== undefined
  ) {
    description =
      visibleText.length === 0
        ? context.folioSourceTitle
        : `${context.folioSourceTitle}: ${visibleText}`;
  }
  return `${context.unverifiedCitationLabel}: ${description}`;
};

const transformHyperlink = (
  hyperlink: Hyperlink,
  context: CitationTransformContext,
): ParagraphContent[] => {
  if (
    hyperlink.href?.startsWith(EMAIL_CITATION_HREF_PREFIX) &&
    parseEmailCitationHref(hyperlink.href) === null
  ) {
    return hyperlink.children;
  }
  if (!isCitationHyperlink(hyperlink, context.internalReferenceMode)) {
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
  if (isVerifiedSearchSummaryTarget(target, context.internalReferenceMode)) {
    context.verifiedCitationCount += 1;
  } else {
    context.unverifiedCitationCount += 1;
  }
  context.footnotes.push(
    createFootnote(id, citationFootnoteText(hyperlink, context)),
  );
  return [...hyperlink.children, createFootnoteReference(id)];
};

const isTrustedSearchSummarySourceParagraph = (
  paragraph: Paragraph,
  context: CitationTransformContext,
): boolean => {
  if (!paragraph.listRendering?.isBullet) {
    return false;
  }
  const first = paragraph.content.at(0);
  if (first === undefined) {
    return false;
  }
  let text = "";
  if (first.type === "hyperlink") {
    text = hyperlinkVisibleText(first);
  } else if (first.type === "run") {
    text = first.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("");
  }
  const number = Number(
    SEARCH_SUMMARY_SOURCE_NUMBER.exec(text)?.groups?.["number"],
  );
  return context.trustedSearchSummaryCitationByNumber.has(number);
};

const transformSearchSummaryCitationMarkers = (
  run: Run,
  context: CitationTransformContext,
): ParagraphContent[] => {
  if (
    context.style === "inline" ||
    context.trustedSearchSummaryCitationByNumber.size === 0
  ) {
    return [run];
  }

  const transformed: ParagraphContent[] = [];
  let changed = false;
  for (const runContent of run.content) {
    if (runContent.type !== "text") {
      transformed.push({ ...run, content: [runContent] });
      continue;
    }

    let textStart = 0;
    for (const match of runContent.text.matchAll(
      SEARCH_SUMMARY_CITATION_MARKER,
    )) {
      const number = Number(match.groups?.["number"]);
      const source = context.trustedSearchSummaryCitationByNumber.get(number);
      if (source === undefined) {
        continue;
      }
      changed = true;
      const before = runContent.text.slice(textStart, match.index);
      if (before.length > 0) {
        transformed.push({ ...run, content: [{ type: "text", text: before }] });
      }
      if (context.style === "footnotes") {
        const target = `${SEARCH_SUMMARY_CITATION_TARGET_PREFIX}${number}`;
        let id = context.footnoteByTarget.get(target);
        if (id === undefined) {
          id = context.nextFootnoteId;
          context.nextFootnoteId += 1;
          context.footnoteByTarget.set(target, id);
          context.verifiedCitationCount += 1;
          context.footnotes.push(createFootnote(id, source));
        }
        transformed.push(createFootnoteReference(id));
      }
      textStart = match.index + match[0].length;
    }
    const remaining = runContent.text.slice(textStart);
    if (remaining.length > 0) {
      transformed.push({
        ...run,
        content: [{ type: "text", text: remaining }],
      });
    }
  }
  return changed ? transformed : [run];
};

const transformParagraph = (
  paragraph: Paragraph,
  context: CitationTransformContext,
): Paragraph => {
  const isTrustedSourceParagraph = isTrustedSearchSummarySourceParagraph(
    paragraph,
    context,
  );
  const content: ParagraphContent[] = [];
  for (const item of paragraph.content) {
    if (item.type === "hyperlink" && !isTrustedSourceParagraph) {
      content.push(...transformHyperlink(item, context));
      continue;
    }
    if (item.type === "run" && !isTrustedSourceParagraph) {
      content.push(...transformSearchSummaryCitationMarkers(item, context));
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
type StyleDocumentCitationsOptions = {
  folioSourceTitle: string | undefined;
  internalCitationFallback: string;
  internalReferenceMode: InternalReferenceMode;
  /** Parsed from a persisted search-summary Sources block. This remains
   * untrusted unless `internalReferenceMode` is `verified-citations`. */
  trustedSearchSummaryCitationSources?:
    | readonly { number: number; source: string }[]
    | undefined;
  unverifiedCitationLabel: string;
};

type StyleDocumentCitationsResult = {
  citationCounts: {
    unverified: number;
    verified: number;
  };
  document: Document;
};

const trustedSearchSummaryCitationByNumber = (
  internalReferenceMode: InternalReferenceMode,
  sources: readonly { number: number; source: string }[] | undefined,
): ReadonlyMap<number, string> => {
  const citations = new Map<number, string>();
  if (internalReferenceMode !== "verified-citations" || sources === undefined) {
    return citations;
  }
  for (const { number, source } of sources) {
    citations.set(number, source);
  }
  return citations;
};

export const styleDocumentCitationsWithCounts = (
  document: Document,
  style: ChatExportCitationStyle,
  {
    folioSourceTitle,
    internalCitationFallback,
    internalReferenceMode,
    trustedSearchSummaryCitationSources,
    unverifiedCitationLabel,
  }: StyleDocumentCitationsOptions,
): StyleDocumentCitationsResult => {
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
    internalReferenceMode,
    nextFootnoteId: nextFootnoteId(footnotes),
    style,
    unverifiedCitationLabel,
    verifiedCitationCount: 0,
    unverifiedCitationCount: 0,
    trustedSearchSummaryCitationByNumber: trustedSearchSummaryCitationByNumber(
      internalReferenceMode,
      trustedSearchSummaryCitationSources,
    ),
  };
  if (style === "inline") {
    const countedTargets = new Set<string>();
    const countInlineCitations = (block: BlockContent): void => {
      switch (block.type) {
        case "paragraph":
          for (const content of block.content) {
            if (
              content.type === "hyperlink" &&
              isCitationHyperlink(content, context.internalReferenceMode) &&
              !countedTargets.has(citationTarget(content))
            ) {
              countedTargets.add(citationTarget(content));
              if (
                isVerifiedSearchSummaryTarget(
                  citationTarget(content),
                  context.internalReferenceMode,
                )
              ) {
                context.verifiedCitationCount += 1;
              } else {
                context.unverifiedCitationCount += 1;
              }
            }
          }
          return;
        case "table":
          for (const row of block.rows) {
            for (const cell of row.cells) {
              for (const child of cell.content) {
                countInlineCitations(child);
              }
            }
          }
          return;
        case "blockSdt":
          for (const child of block.content) {
            countInlineCitations(child);
          }
          return;
        default:
          return unreachable(
            `Unhandled document block: ${JSON.stringify(block)}`,
          );
      }
    };
    for (const block of document.package.document.content) {
      countInlineCitations(block);
    }
    return {
      citationCounts: {
        unverified: context.unverifiedCitationCount,
        verified: context.verifiedCitationCount,
      },
      document,
    };
  }
  const content = document.package.document.content.map((block) =>
    transformBlock(block, context),
  );

  return {
    citationCounts: {
      unverified: context.unverifiedCitationCount,
      verified: context.verifiedCitationCount,
    },
    document: {
      ...document,
      package: {
        ...document.package,
        document: {
          ...document.package.document,
          content,
        },
        footnotes: context.footnotes,
      },
    },
  };
};

export const styleDocumentCitations = (
  document: Document,
  style: ChatExportCitationStyle,
  options: StyleDocumentCitationsOptions,
): Document =>
  styleDocumentCitationsWithCounts(document, style, options).document;
