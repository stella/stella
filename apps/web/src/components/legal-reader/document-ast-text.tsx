import { Fragment } from "react";
import type { ReactNode } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { plainTextOf } from "@stll/legal-ast/document-ast";
import type { Block, HeadingLevel, Inline } from "@stll/legal-ast/document-ast";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import type {
  SearchMatchRange,
  SearchPiece,
} from "@/components/legal-reader/reader-search";
import { getAnalytics } from "@/lib/analytics/provider";
import { normalizeOptionalArray } from "@/lib/arrays";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { detached } from "@/lib/detached";
import { sanitizeHref } from "@/lib/sanitize-href";

import "./reader.css";

/**
 * Renderers for a `DocumentAst`, shared by every reader over the legal
 * corpus. Nothing here knows which corpus a document came from: the
 * case-law viewer and the statutes reader compose the same blocks,
 * headings, inline runs and search highlighting.
 */

export const rangesForPiece = (
  rangesByPieceId: Record<string, SearchMatchRange[]>,
  pieceId: string,
): SearchMatchRange[] => {
  const ranges = rangesByPieceId[pieceId];
  return normalizeOptionalArray(ranges);
};

/**
 * A span of a piece's plain text that a reader wraps in its own element: a
 * link to a cited decision, for instance. Offsets index `plainText`, the
 * same axis as search ranges; anchors within one piece must not overlap.
 */
export type TextAnchor = {
  end: number;
  key: string;
  render: (children: ReactNode) => ReactNode;
  start: number;
};

export const anchorsForPiece = (
  anchorsByPieceId: Record<string, TextAnchor[]> | undefined,
  pieceId: string,
): TextAnchor[] =>
  anchorsByPieceId === undefined
    ? []
    : normalizeOptionalArray(anchorsByPieceId[pieceId]);

type HighlightContext = {
  activeMatchIndex: number;
  anchors: TextAnchor[];
  pieceId: string;
  ranges: SearchMatchRange[];
};

type OffsetRef = { value: number };
type SynchronousNode =
  | React.JSX.Element
  | ReactNode[]
  | Iterable<SynchronousNode>
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined;

/**
 * The raw inline flattening, re-exported under the name this reader has
 * always used for it.
 *
 * Search pieces and citation anchors must come from this, NOT from
 * `block.plainText`: ingestion derives `plainText` with
 * `projectPlainText`, which trims and collapses letter-spaced runs for
 * search, so its offsets would not line up with the ones the highlight
 * renderer walks.
 */
export const inlinesToPlainText = plainTextOf;

export const getParagraphNumberPieceId = (blockId: string): string =>
  `paragraph-number:${blockId}`;

export const getTableCellPieceId = ({
  blockId,
  columnIndex,
  rowIndex,
}: {
  blockId: string;
  columnIndex: number;
  rowIndex: number;
}): string => `table:${blockId}:${rowIndex}:${columnIndex}`;

const renderHighlightedSlice = ({
  activeMatchIndex,
  pieceId,
  ranges,
  segmentStart,
  text,
}: {
  activeMatchIndex: number;
  pieceId: string;
  ranges: SearchMatchRange[];
  segmentStart: number;
  text: string;
}): SynchronousNode => {
  const segmentEnd = segmentStart + text.length;
  const relevantRanges = ranges.filter(
    (range) => range.end > segmentStart && range.start < segmentEnd,
  );

  if (relevantRanges.length === 0) {
    return text;
  }

  const children: ReactNode[] = [];
  let cursor = segmentStart;

  for (const range of relevantRanges) {
    const localStart = Math.max(range.start - segmentStart, 0);
    const localEnd = Math.min(range.end - segmentStart, text.length);

    if (localStart > cursor - segmentStart) {
      children.push(text.slice(cursor - segmentStart, localStart));
    }

    const isActive = range.matchIndex === activeMatchIndex;
    children.push(
      <mark
        className={cn(
          "text-inherit",
          isActive
            ? "bg-primary/40 text-primary-foreground ring-primary ring-1"
            : "bg-primary/22",
        )}
        data-reader-match-index={range.matchIndex}
        key={`${pieceId}-${range.matchIndex}-${localStart}`}
      >
        {text.slice(localStart, localEnd)}
      </mark>,
    );
    cursor = segmentStart + localEnd;
  }

  if (cursor < segmentEnd) {
    children.push(text.slice(cursor - segmentStart));
  }

  return children;
};

/**
 * One text node's worth of plain text: split at anchor boundaries, each
 * slice highlighted on its own, anchored slices wrapped by their anchor.
 * A search match crossing an anchor boundary is drawn as two marks that
 * share a match index, so the find bar still lands on it.
 */
const renderTextSegment = ({
  activeMatchIndex,
  anchors,
  anonymized,
  pieceId,
  ranges,
  segmentStart,
  text,
}: {
  activeMatchIndex: number;
  anchors: TextAnchor[];
  anonymized?: boolean | undefined;
  pieceId: string;
  ranges: SearchMatchRange[];
  segmentStart: number;
  text: string;
}): SynchronousNode => {
  const segmentEnd = segmentStart + text.length;
  const relevantAnchors = anchors.filter(
    (anchor) => anchor.end > segmentStart && anchor.start < segmentEnd,
  );

  const highlight = (sliceStart: number, sliceEnd: number) =>
    renderHighlightedSlice({
      activeMatchIndex,
      pieceId,
      ranges,
      segmentStart: sliceStart,
      text: text.slice(sliceStart - segmentStart, sliceEnd - segmentStart),
    });

  let content: SynchronousNode;
  if (relevantAnchors.length === 0) {
    content = highlight(segmentStart, segmentEnd);
  } else {
    const children: ReactNode[] = [];
    let cursor = segmentStart;
    for (const anchor of relevantAnchors) {
      const anchorStart = Math.max(anchor.start, segmentStart);
      const anchorEnd = Math.min(anchor.end, segmentEnd);
      if (anchorStart > cursor) {
        children.push(
          <Fragment key={`plain-${String(cursor)}`}>
            {highlight(cursor, anchorStart)}
          </Fragment>,
        );
      }
      children.push(
        <Fragment key={`${anchor.key}-${String(anchorStart)}`}>
          {anchor.render(highlight(anchorStart, anchorEnd))}
        </Fragment>,
      );
      cursor = anchorEnd;
    }
    if (cursor < segmentEnd) {
      children.push(
        <Fragment key={`plain-${String(cursor)}`}>
          {highlight(cursor, segmentEnd)}
        </Fragment>,
      );
    }
    content = children;
  }

  if (anonymized) {
    return (
      <span className="bg-muted/60 text-muted-foreground rounded-sm px-0.5">
        [{content}]
      </span>
    );
  }

  return content;
};

const renderInline = ({
  context,
  key,
  node,
  offset,
}: {
  context: HighlightContext;
  key: number;
  node: Inline;
  offset: OffsetRef;
}): SynchronousNode => {
  if (node.type === "text") {
    const segmentStart = offset.value;
    offset.value += node.text.length;

    return (
      <Fragment key={key}>
        {renderTextSegment({
          activeMatchIndex: context.activeMatchIndex,
          anchors: context.anchors,
          anonymized: node.anonymized,
          pieceId: context.pieceId,
          ranges: context.ranges,
          segmentStart,
          text: node.text,
        })}
      </Fragment>
    );
  }

  if (node.type === "line-break") {
    // SAFETY: `plainText` is produced by `inlinesToPlainText`, which encodes each
    // `line-break` node as a single "\n". The renderer must advance by the same
    // one-character offset so search highlight ranges stay aligned with `plainText`.
    offset.value += 1;
    return <br key={key} />;
  }

  if (node.type === "bold") {
    return (
      <strong className="font-[650]" key={key}>
        {renderInlineChildren({ children: node.children, context, offset })}
      </strong>
    );
  }

  if (node.type === "italic") {
    return (
      <em className="italic" key={key}>
        {renderInlineChildren({ children: node.children, context, offset })}
      </em>
    );
  }

  const safeHref = sanitizeHref(node.href);
  if (!safeHref) {
    return (
      <Fragment key={key}>
        {renderInlineChildren({ children: node.children, context, offset })}
      </Fragment>
    );
  }

  // Inside a source link the source wins: an anchor nested in an anchor is
  // invalid HTML and sends the click to whichever element the browser picks.
  const children = renderInlineChildren({
    children: node.children,
    context: { ...context, anchors: [] },
    offset,
  });

  return (
    <a
      className="decoration-border underline underline-offset-2 hover:decoration-current"
      href={sanitizeHref(node.href)}
      key={key}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
};

const renderInlineChildren = ({
  children,
  context,
  offset,
}: {
  children: Inline[];
  context: HighlightContext;
  offset: OffsetRef;
}): SynchronousNode[] => {
  const renderedChildren: SynchronousNode[] = [];

  for (const [index, child] of children.entries()) {
    renderedChildren.push(
      renderInline({ context, key: index, node: child, offset }),
    );
  }

  return renderedChildren;
};

const NO_ANCHORS: TextAnchor[] = [];

export const InlineContent = ({
  activeMatchIndex,
  anchors = NO_ANCHORS,
  inlines,
  pieceId,
  ranges,
}: {
  activeMatchIndex: number;
  anchors?: TextAnchor[] | undefined;
  inlines: Inline[];
  pieceId: string;
  ranges: SearchMatchRange[];
}) => {
  const offset: OffsetRef = { value: 0 };
  const context: HighlightContext = {
    anchors,
    pieceId,
    ranges,
    activeMatchIndex,
  };

  return <>{renderInlineChildren({ children: inlines, context, offset })}</>;
};

export const HighlightedText = ({
  activeMatchIndex,
  className,
  pieceId,
  ranges,
  text,
}: {
  activeMatchIndex: number;
  className?: string | undefined;
  pieceId: string;
  ranges: SearchMatchRange[];
  text: string;
}) => (
  <span className={className}>
    {renderHighlightedSlice({
      activeMatchIndex,
      pieceId,
      ranges,
      segmentStart: 0,
      text,
    })}
  </span>
);

/**
 * Which corpus a reader is rendering.
 *
 * The blocks are the same; the typography is not. A decision's headings are
 * the court's own section breaks, while a statute's are a nested chain of
 * containers the reader navigates by, and the publisher sets them centred
 * and heavier for exactly that reason.
 */
export type ReaderVariant = "case-law" | "statute";

/**
 * Class per variant and heading depth. Total over both, so neither a new
 * reader nor a depth the AST can carry reaches the page with no styling.
 */
export const HEADING_CLASS = {
  "case-law": {
    1: "mt-4 mb-5 text-center text-lg leading-tight font-bold tracking-widest first:mt-0",
    2: "mt-[var(--reader-section-gap-top)] mb-[var(--reader-section-gap-bottom)] text-center text-[0.95rem] leading-snug font-bold tracking-wider",
    3: "mt-[var(--reader-section-gap-top)] mb-[var(--reader-section-gap-bottom)] text-center text-sm leading-snug font-semibold",
    4: "mt-[var(--reader-section-gap-top)] mb-[var(--reader-section-gap-bottom)] text-center text-sm leading-snug font-medium",
    5: "mt-[var(--reader-section-gap-top)] mb-[var(--reader-section-gap-bottom)] text-sm leading-snug font-semibold",
    6: "mt-[var(--reader-section-gap-top)] mb-[var(--reader-section-gap-bottom)] text-sm leading-snug font-medium",
  },
  // Levels 1 to 4 are the containers (Část, Hlava, Díl, Oddíl): centred and
  // bold, stepping down only slightly, because a `Díl` is not a smaller
  // thing than a `HLAVA`, it is a nearer one. They carry the hierarchy.
  //
  // Levels 5 and 6 are the section itself — the title of a group of
  // sections, and the section designation that opens the provision. Both
  // stay at reading weight: the designation is a marker the eye finds, not
  // another rung of the hierarchy, so bolding it flattens the four levels
  // above it. Level 6 keeps its own approach gap even though it is the
  // deepest: it is a provision boundary rather than a container.
  //
  // The rhythm — a large gap into a new container, a small one between a
  // container and the container it opens — is in `reader.css`, where a
  // sibling selector can see the chain.
  statute: {
    1: "mt-[var(--reader-heading-gap-1)] mb-[var(--reader-heading-gap-bottom)] text-center text-[1.35rem] leading-tight font-bold tracking-widest first:mt-0",
    2: "mt-[var(--reader-heading-gap-2)] mb-[var(--reader-heading-gap-bottom)] text-center text-[1.25rem] leading-snug font-bold tracking-wide",
    3: "mt-[var(--reader-heading-gap-3)] mb-[var(--reader-heading-gap-bottom)] text-center text-[1.15rem] leading-snug font-bold",
    4: "mt-[var(--reader-heading-gap-4)] mb-[var(--reader-heading-gap-bottom)] text-center text-[1.15rem] leading-snug font-bold",
    5: "mt-[var(--reader-heading-gap-5)] mb-[var(--reader-heading-gap-bottom)] text-center text-[1.05rem] leading-snug font-semibold",
    6: "mt-[var(--reader-heading-gap-6)] mb-[var(--reader-heading-gap-bottom)] text-center text-[1rem] leading-snug font-semibold",
  },
} as const satisfies Record<ReaderVariant, Record<HeadingLevel, string>>;

/**
 * A block's own address, as a link the reader can take with them.
 *
 * The `href` alone is what makes it work: following it is native anchor
 * navigation, so the hash lands in the URL and `:target` flashes the block
 * without a single line of script. The clipboard copy on top is the
 * convenience, not the mechanism.
 */
const BlockPermalink = ({ anchorId }: { anchorId: string }) => {
  const t = useTranslations();

  const copyPermalink = async () => {
    const url = new URL(window.location.href);
    url.hash = anchorId;
    const copied = await copyToClipboard(url.href);
    if (Result.isError(copied)) {
      getAnalytics().captureError(copied.error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    stellaToast.add({ title: t("common.copied"), type: "success" });
  };

  return (
    <a
      aria-label={t("common.copyLink")}
      className="text-foreground-disabled hover:text-foreground focus-visible:ring-ring absolute end-full top-0 me-1 rounded-sm px-1 leading-[inherit] no-underline opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none print:hidden [@media(hover:none)]:opacity-100"
      href={`#${anchorId}`}
      onClick={() => {
        detached(copyPermalink(), "legal-reader.permalink-copy");
      }}
    >
      ¶
    </a>
  );
};

export const BlockRenderer = ({
  activeMatchIndex,
  anchorsByPieceId,
  block,
  rangesByPieceId,
  variant,
}: {
  activeMatchIndex: number;
  anchorsByPieceId?: Record<string, TextAnchor[]> | undefined;
  block: Block;
  rangesByPieceId: Record<string, SearchMatchRange[]>;
  variant: ReaderVariant;
}) => {
  if (block.type === "heading") {
    const Tag = `h${block.level}` as const;
    return (
      <Tag
        className={cn(
          "group relative scroll-mt-[var(--reader-anchor-offset)]",
          HEADING_CLASS[variant][block.level],
        )}
        data-anchor={block.anchorId}
        id={block.anchorId}
      >
        <BlockPermalink anchorId={block.anchorId} />
        <InlineContent
          activeMatchIndex={activeMatchIndex}
          anchors={anchorsForPiece(anchorsByPieceId, block.id)}
          inlines={block.inlines}
          pieceId={block.id}
          ranges={rangesForPiece(rangesByPieceId, block.id)}
        />
      </Tag>
    );
  }

  if (block.type === "paragraph") {
    // Short standalone roman numerals (I, II, III …) that the
    // parser emitted as paragraphs are section dividers; centre
    // them like level-3 headings instead of bleeding into the
    // body copy.
    const isRomanNumeralDivider = /^[IVX]+\.?$/u.test(block.plainText.trim());
    // Non-body roles (case number, closing formula, signature)
    // need their own alignment; every other paragraph — including
    // intro, argumentation and unroled body text — defaults to
    // justified reading layout.
    const nonJustifiedRoles = new Set(["case-number", "closing", "signature"]);
    const shouldJustify =
      !isRomanNumeralDivider &&
      (block.role === undefined || !nonJustifiedRoles.has(block.role));
    return (
      <p
        className={cn(
          "group relative mb-[var(--reader-paragraph-gap)] scroll-mt-[var(--reader-anchor-offset)] last:mb-0",
          shouldJustify && "reader-justify",
          block.role === "holding" && "font-[520]",
          block.note?.type === "footnote" &&
            "text-muted-foreground border-border mb-2 border-s-2 ps-4 text-[0.86em] leading-relaxed",
          isRomanNumeralDivider &&
            "mt-[var(--reader-section-gap-top)] mb-[var(--reader-section-gap-bottom)] text-center text-sm font-semibold",
          block.role === "case-number" &&
            "text-muted-foreground mb-2 text-end font-sans text-[0.95rem]",
          block.role === "closing" && "mt-8 text-center",
          block.role === "signature" &&
            "reader-signature text-muted-foreground mt-1 text-end",
          // Courts that number their paragraphs are cited by that
          // number, so it hangs in the margin rather than running into
          // the sentence, the way the published decision prints it.
          block.number !== undefined && "ps-8",
        )}
        data-anchor={block.anchorId}
        id={block.anchorId}
      >
        <BlockPermalink anchorId={block.anchorId} />
        {block.number !== undefined && (
          <HighlightedText
            activeMatchIndex={activeMatchIndex}
            className="text-muted-foreground absolute start-0 font-sans text-[0.8em] select-none"
            pieceId={getParagraphNumberPieceId(block.id)}
            ranges={rangesForPiece(
              rangesByPieceId,
              getParagraphNumberPieceId(block.id),
            )}
            text={String(block.number)}
          />
        )}
        <InlineContent
          activeMatchIndex={activeMatchIndex}
          anchors={anchorsForPiece(anchorsByPieceId, block.id)}
          inlines={block.inlines}
          pieceId={block.id}
          ranges={rangesForPiece(rangesByPieceId, block.id)}
        />
      </p>
    );
  }

  // The permalink is a link, and a link is not allowed inside `<table>`, so
  // the wrapper carries it. The anchor id stays on the table itself: it is
  // what every deep link already written points at.
  return (
    <div className="group relative">
      <BlockPermalink anchorId={block.anchorId} />
      <table
        className="my-4 w-full border-collapse scroll-mt-[var(--reader-anchor-offset)] font-sans text-[0.88rem]"
        data-anchor={block.anchorId}
        id={block.anchorId}
      >
        <tbody>
          {block.rows.map((row, rowIndex) => (
            // eslint-disable-next-line react/no-array-index-key -- read-only case-law document table parsed once from source text; rows are positionally fixed (rowIndex feeds getTableCellPieceId's identity below) and never reordered/inserted by the reader UI.
            <tr key={rowIndex}>
              {row.map((cell, columnIndex) => {
                const pieceId = getTableCellPieceId({
                  blockId: block.id,
                  rowIndex,
                  columnIndex,
                });

                return (
                  <td
                    className="border-border/55 border-b px-3 py-1 align-top last:border-b-0"
                    key={pieceId}
                  >
                    <InlineContent
                      activeMatchIndex={activeMatchIndex}
                      inlines={cell.inlines}
                      pieceId={pieceId}
                      ranges={rangesForPiece(rangesByPieceId, pieceId)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const FulltextFallback = ({
  activeMatchIndex,
  rangesByPieceId,
  text,
}: {
  activeMatchIndex: number;
  rangesByPieceId: Record<string, SearchMatchRange[]>;
  text: string;
}) => {
  const paragraphs = text.split(/\n{2,}/u);

  return (
    <>
      {paragraphs.map((paragraph, index) => {
        const pieceId = `fulltext:${index}`;

        return (
          <p
            className="mb-[var(--reader-paragraph-gap)] last:mb-0"
            key={pieceId}
          >
            <HighlightedText
              activeMatchIndex={activeMatchIndex}
              pieceId={pieceId}
              ranges={rangesForPiece(rangesByPieceId, pieceId)}
              text={paragraph}
            />
          </p>
        );
      })}
    </>
  );
};

/**
 * Search pieces for a block list, in render order. Table cells get one
 * piece each so a match scrolls to the cell, and a hanging paragraph
 * number gets its own piece: folding it into the paragraph's text would
 * shift every highlight offset in that paragraph.
 */
export const buildDocumentAstSearchPieces = (
  blocks: readonly Block[],
): SearchPiece[] => {
  const pieces: SearchPiece[] = [];

  for (const block of blocks) {
    if (block.type === "table") {
      for (const [rowIndex, row] of block.rows.entries()) {
        for (const [columnIndex, cell] of row.entries()) {
          pieces.push({
            id: getTableCellPieceId({
              blockId: block.id,
              rowIndex,
              columnIndex,
            }),
            text: inlinesToPlainText(cell.inlines),
          });
        }
      }
      continue;
    }

    pieces.push({ id: block.id, text: inlinesToPlainText(block.inlines) });

    if (block.type === "paragraph" && block.number !== undefined) {
      pieces.push({
        id: getParagraphNumberPieceId(block.id),
        text: String(block.number),
      });
    }
  }

  return pieces;
};

/** Search pieces for the paragraph split `FulltextFallback` renders. */
export const buildFulltextSearchPieces = (text: string): SearchPiece[] =>
  text.split(/\n{2,}/u).map((paragraph, index) => ({
    id: `fulltext:${index}`,
    text: paragraph,
  }));
