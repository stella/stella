import { Fragment } from "react";
import type { ReactNode } from "react";

import type { Block, HeadingLevel, Inline } from "@stll/legal-ast/document-ast";
import { cn } from "@stll/ui/lib/utils";

import type {
  SearchMatchRange,
  SearchPiece,
} from "@/components/legal-reader/reader-search";
import { normalizeOptionalArray } from "@/lib/arrays";
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

type HighlightContext = {
  activeMatchIndex: number;
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
 * Flatten `inlines` into the same character sequence that `renderInline`
 * walks through when it tracks offsets: text nodes contribute verbatim,
 * line-breaks are a single "\n", bold/italic/link children are recursed
 * into.
 *
 * Search pieces must come from this, NOT from `block.plainText`: the API
 * pipeline collapses spaced-letter runs in `plainText` (for DB FTS) while
 * leaving inline text untouched, so `plainText` offsets would not line up
 * with the offsets the highlight renderer uses.
 */
export const inlinesToPlainText = (inlines: readonly Inline[]): string => {
  let out = "";
  for (const node of inlines) {
    if (node.type === "text") {
      out += node.text;
    } else if (node.type === "line-break") {
      out += "\n";
    } else {
      out += inlinesToPlainText(node.children);
    }
  }
  return out;
};

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

const renderTextSegment = ({
  activeMatchIndex,
  anonymized,
  pieceId,
  ranges,
  segmentStart,
  text,
}: {
  activeMatchIndex: number;
  anonymized?: boolean | undefined;
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
    if (anonymized) {
      return (
        <span className="bg-muted/60 text-muted-foreground rounded-sm px-0.5">
          [{text}]
        </span>
      );
    }
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

  if (anonymized) {
    return (
      <span className="bg-muted/60 text-muted-foreground rounded-sm px-0.5">
        [{children}]
      </span>
    );
  }

  return children;
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
  const children = renderInlineChildren({
    children: node.children,
    context,
    offset,
  });

  if (!safeHref) {
    return <Fragment key={key}>{children}</Fragment>;
  }

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

export const InlineContent = ({
  activeMatchIndex,
  inlines,
  pieceId,
  ranges,
}: {
  activeMatchIndex: number;
  inlines: Inline[];
  pieceId: string;
  ranges: SearchMatchRange[];
}) => {
  const offset: OffsetRef = { value: 0 };
  const context: HighlightContext = {
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
    {renderTextSegment({
      activeMatchIndex,
      pieceId,
      ranges,
      segmentStart: 0,
      text,
    })}
  </span>
);

/**
 * Class per heading depth. Total over `HeadingLevel`, so a depth the AST can
 * carry cannot reach the reader with no styling of its own.
 */
export const HEADING_CLASS = {
  1: "mt-4 mb-5 text-center text-lg leading-tight font-bold tracking-widest first:mt-0",
  2: "mt-[var(--reader-section-gap-top)] mb-[var(--reader-section-gap-bottom)] text-center text-[0.95rem] leading-snug font-bold tracking-wider",
  3: "mt-[var(--reader-section-gap-top)] mb-[var(--reader-section-gap-bottom)] text-center text-sm leading-snug font-semibold",
  4: "mt-[var(--reader-section-gap-top)] mb-[var(--reader-section-gap-bottom)] text-center text-sm leading-snug font-medium",
  5: "mt-[var(--reader-section-gap-top)] mb-[var(--reader-section-gap-bottom)] text-sm leading-snug font-semibold",
  6: "mt-[var(--reader-section-gap-top)] mb-[var(--reader-section-gap-bottom)] text-sm leading-snug font-medium",
} as const satisfies Record<HeadingLevel, string>;

export const BlockRenderer = ({
  activeMatchIndex,
  block,
  rangesByPieceId,
}: {
  activeMatchIndex: number;
  block: Block;
  rangesByPieceId: Record<string, SearchMatchRange[]>;
}) => {
  if (block.type === "heading") {
    const Tag = `h${block.level}` as const;
    return (
      <Tag
        className={cn(
          "scroll-mt-[var(--reader-anchor-offset)]",
          HEADING_CLASS[block.level],
        )}
        id={block.anchorId}
      >
        <InlineContent
          activeMatchIndex={activeMatchIndex}
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
          "mb-[var(--reader-paragraph-gap)] scroll-mt-[var(--reader-anchor-offset)] last:mb-0",
          shouldJustify && "reader-justify",
          block.role === "holding" && "font-[520]",
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
          block.number !== undefined && "relative ps-8",
        )}
        id={block.anchorId}
      >
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
          inlines={block.inlines}
          pieceId={block.id}
          ranges={rangesForPiece(rangesByPieceId, block.id)}
        />
      </p>
    );
  }

  return (
    <table
      className="my-4 w-full border-collapse scroll-mt-[var(--reader-anchor-offset)] font-sans text-[0.88rem]"
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
