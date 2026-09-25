import { Fragment, useState } from "react";
import type { ReactNode } from "react";

import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { copyToClipboard } from "@stll/clipboard";
import { plainTextOf, tableCellPieceId } from "@stll/legal-ast/document-ast";
import type {
  Block,
  HeadingLevel,
  Inline,
  ParagraphListDepth,
} from "@stll/legal-ast/document-ast";
import {
  ReviewDiffDeletion,
  ReviewDiffInsertion,
} from "@stll/ui/review-diff-text";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { SEARCH_MARK_CLASS_NAME } from "@/components/legal-reader/query-marks";
import type {
  ReaderMark,
  ReaderMarkRange,
  SearchMatchRange,
  SearchPiece,
} from "@/components/legal-reader/reader-search";
import {
  readerHref,
  useSourceLinkPolicy,
} from "@/components/legal-reader/source-link-policy";
import type { SourceLinkPolicy } from "@/components/legal-reader/source-link-policy";
import Tooltip from "@/components/tooltip";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { normalizeOptionalArray } from "@/lib/arrays";
import { detached } from "@/lib/detached";
import { forceReflow } from "@/lib/utils";

import "./reader.css";

/**
 * Renderers for a `DocumentAst`, shared by every reader over the legal
 * corpus. Nothing here knows which corpus a document came from: the
 * case-law viewer and the statutes reader compose the same blocks,
 * headings, inline runs and search highlighting.
 */

export const rangesForPiece = <Range extends ReaderMarkRange>(
  rangesByPieceId: Record<string, Range[]>,
  pieceId: string,
): Range[] => {
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

/**
 * Whether blocks are the document itself (they carry its DOM ids and its
 * in-document navigation) or an excerpt set inside another page, which must
 * not repeat those ids and has no targets for a fragment link to reach.
 */
export type AnchorPresentation = "document" | "embedded";

type HighlightContext = {
  activeMatchIndex: number;
  anchorPresentation: AnchorPresentation;
  anchors: TextAnchor[];
  pieceId: string;
  ranges: ReaderMarkRange[];
  /**
   * Which of the source document's own hyperlinks reach the page; see
   * `source-link-policy.tsx`. Carried on the context rather than read per
   * node, so every `href` this file writes is decided by one call.
   */
  sourceLinks: SourceLinkPolicy;
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

/**
 * The one match the find is standing on. Same mark as the rest — the reader is
 * reading, not being pointed at — with a ring around it so stepping through
 * the matches is visible.
 */
const ACTIVE_MATCH_RING = "ring-warning ring-1";

type DiffMarkType = Exclude<ReaderMark["type"], "search">;

/** What a screen reader hears before a changed run: sighted readers see the
 * strike or the wash, and neither is spoken. */
const DIFF_MARK_LABEL_KEYS = {
  deleted: "statutes.diffRemoved",
  inserted: "statutes.diffInserted",
} as const satisfies Record<DiffMarkType, TranslationKey>;

const DiffMarkLabel = ({ type }: { type: DiffMarkType }) => {
  const t = useTranslations();

  // Chrome, not wording: a copied passage must not carry the label. The
  // space keeps it from running into the first changed word when read.
  return (
    <span className="sr-only select-none" data-reader-chrome="">
      {t(DIFF_MARK_LABEL_KEYS[type])}{" "}
    </span>
  );
};

type RenderMarkOptions = {
  activeMatchIndex: number;
  /** This slice opens the range rather than continuing it. */
  isRangeStart: boolean;
  key: string;
  range: ReaderMarkRange;
  text: string;
};

/**
 * One marked slice. Search matches wear the query mark; a comparison's
 * changes wear the product's one track-changes language, so a statute diff
 * reads the same as every other diff.
 */
const renderMark = ({
  activeMatchIndex,
  isRangeStart,
  key,
  range,
  text,
}: RenderMarkOptions): React.JSX.Element => {
  switch (range.type) {
    case "search":
      return (
        <mark
          className={cn(
            SEARCH_MARK_CLASS_NAME,
            range.matchIndex === activeMatchIndex && ACTIVE_MATCH_RING,
          )}
          data-reader-match-index={range.matchIndex}
          key={key}
        >
          {text}
        </mark>
      );
    case "inserted":
      return (
        <ReviewDiffInsertion key={key}>
          {isRangeStart && <DiffMarkLabel type={range.type} />}
          {text}
        </ReviewDiffInsertion>
      );
    case "deleted":
      return (
        <ReviewDiffDeletion key={key}>
          {isRangeStart && <DiffMarkLabel type={range.type} />}
          {text}
        </ReviewDiffDeletion>
      );
    default:
      range satisfies never;
      return panic("Unhandled reader mark");
  }
};

const renderHighlightedSlice = ({
  activeMatchIndex,
  pieceId,
  ranges,
  segmentStart,
  text,
}: {
  activeMatchIndex: number;
  pieceId: string;
  ranges: ReaderMarkRange[];
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

    children.push(
      renderMark({
        activeMatchIndex,
        // A range cut by an inline boundary is drawn as several marks; the
        // label is read once, before the first of them.
        isRangeStart: range.start >= segmentStart,
        key: `${pieceId}-${range.type}-${localStart}`,
        range,
        text: text.slice(localStart, localEnd),
      }),
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
  ranges: ReaderMarkRange[];
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

  if (node.type === "underline") {
    return (
      <u className="underline-offset-2" key={key}>
        {renderInlineChildren({ children: node.children, context, offset })}
      </u>
    );
  }

  if (node.type === "superscript") {
    return (
      <sup key={key}>
        {renderInlineChildren({ children: node.children, context, offset })}
      </sup>
    );
  }

  if (node.type === "subscript") {
    return (
      <sub key={key}>
        {renderInlineChildren({ children: node.children, context, offset })}
      </sub>
    );
  }

  // A reference to another authority. `data-cite` carries the citation as
  // the publisher printed it, so the citator reads it off the element
  // rather than re-parsing the words around it; the words themselves are
  // the children and stay on the text axis untouched.
  if (node.type === "citation") {
    const citationHref = readerHref(node.href, context.sourceLinks);
    if (citationHref === undefined) {
      // Children keep the full context, anchors included: a reference whose
      // source link the policy withholds is exactly the one our own statute
      // or decision link should take over.
      return (
        <span data-cite={node.cite} key={key}>
          {renderInlineChildren({ children: node.children, context, offset })}
        </span>
      );
    }
    return (
      <a
        className="decoration-border underline underline-offset-2 hover:decoration-current"
        data-cite={node.cite}
        href={readerHref(node.href, context.sourceLinks)}
        key={key}
        rel="noopener noreferrer"
        target="_blank"
      >
        {renderInlineChildren({
          children: node.children,
          // A link inside a link sends the click to whichever the browser
          // picks; the source's own link wins.
          context: { ...context, anchors: [] },
          offset,
        })}
      </a>
    );
  }

  // A page boundary: zero characters on the text axis (no offset advance),
  // shown as a hanging margin marker plus a hair-thin tick at the exact
  // break point. Neither is selectable, so copies stay clean.
  if (node.type === "page-anchor") {
    const pageHref = readerHref(node.href, context.sourceLinks);
    return (
      <Fragment key={key}>
        {pageHref === undefined ? (
          <span className="reader-page-marker" data-reader-chrome="">
            {node.label}
          </span>
        ) : (
          <a
            className="reader-page-marker"
            data-reader-chrome=""
            href={readerHref(node.href, context.sourceLinks)}
            rel="noopener noreferrer"
            target="_blank"
          >
            {node.label}
          </a>
        )}
        <span aria-hidden className="reader-page-tick" data-reader-chrome="" />
      </Fragment>
    );
  }

  const safeHref = readerHref(node.href, context.sourceLinks);
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

  // An in-document link (footnote reference, back-reference) navigates the
  // reader itself; a new tab would strand it. Note references render as
  // superscript marks, the way the published decision prints them, and
  // preview the note's text on hover.
  if (safeHref.startsWith("#")) {
    // An excerpt carries none of the ids a fragment points at, and the page
    // around it may carry the same id for something else: the reference
    // keeps its words and loses the jump.
    if (context.anchorPresentation === "embedded") {
      return <Fragment key={key}>{children}</Fragment>;
    }
    return (
      <NoteRefLink key={key} targetId={safeHref.slice(1)}>
        {children}
      </NoteRefLink>
    );
  }

  return (
    <a
      className="decoration-border underline underline-offset-2 hover:decoration-current"
      href={readerHref(node.href, context.sourceLinks)}
      key={key}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
};

const NOTE_PREVIEW_MAX_CHARS = 600;

/** The note's own words, read from its rendered block: chrome stripped,
 * whitespace collapsed, capped for the popup. */
const notePreviewOf = (targetId: string): string | null => {
  const el = document.querySelector(`#${targetId}`);
  if (!el) {
    return null;
  }
  const clone = el.cloneNode(true);
  if (!(clone instanceof Element)) {
    return null;
  }
  for (const chrome of clone.querySelectorAll("[data-reader-chrome]")) {
    chrome.remove();
  }
  const text = clone.textContent.replaceAll(/\s+/gu, " ").trim();
  if (text === "") {
    return null;
  }
  return text.length > NOTE_PREVIEW_MAX_CHARS
    ? `${text.slice(0, NOTE_PREVIEW_MAX_CHARS)}…`
    : text;
};

/**
 * In-document note reference. The preview is read from the live DOM on
 * hover rather than threaded through props: the note's block renders from
 * the same AST, so the DOM is the cheapest correct source.
 */
const NoteRefLink = ({
  children,
  targetId,
}: {
  children: ReactNode;
  /** The block this reference jumps to, without the `#`. */
  targetId: string;
}) => {
  const [preview, setPreview] = useState<string | null>(null);
  return (
    <Tooltip
      content={
        <span className="block max-w-xs text-start leading-snug">
          {preview}
        </span>
      }
      render={
        // The visible text is injected as the Tooltip trigger's children by
        // the composition below; the aria-label satisfies the accessible
        // name statically.
        <a
          aria-label={targetId}
          className="reader-note-ref"
          href={`#${targetId}`}
          onClick={(event) => {
            // Scripted jump instead of native hash navigation: centers the
            // note, and the flash re-fires on every click — `:target` only
            // animates when the hash actually changes.
            event.preventDefault();
            const el = document.querySelector<HTMLElement>(
              `#${CSS.escape(targetId)}`,
            );
            if (!el) {
              return;
            }
            el.scrollIntoView({ behavior: "instant", block: "center" });
            delete el.dataset["highlight"];
            forceReflow(el);
            el.dataset["highlight"] = "";
          }}
          onMouseEnter={() => setPreview(notePreviewOf(targetId))}
        />
      }
    >
      {children}
    </Tooltip>
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
const BARE_HTTP_URL_RE = /https?:\/\/[^\s<>"']+/giu;
const BARE_URL_TRAILING_PUNCTUATION = "),.;:!?";

const trimBareUrlPunctuation = (value: string): string => {
  let end = value.length;
  while (end > 0) {
    const character = value.at(end - 1);
    if (
      character === undefined ||
      !BARE_URL_TRAILING_PUNCTUATION.includes(character)
    ) {
      break;
    }
    end -= 1;
  }
  return value.slice(0, end);
};

/**
 * A bare URL printed in the text, auto-linked. Subject to the same policy as
 * a link the AST carries: this manufactures a hyperlink the source document
 * never marked up, so a vendor address typed into a court's prose would
 * otherwise reach the page as a link with every `link` node already blocked.
 */
const bareUrlAnchors = (
  text: string,
  reserved: readonly TextAnchor[],
  initialOffset: number,
  sourceLinks: SourceLinkPolicy,
): TextAnchor[] => {
  const anchors: TextAnchor[] = [];
  for (const match of text.matchAll(BARE_HTTP_URL_RE)) {
    const start = initialOffset + match.index;
    const url = trimBareUrlPunctuation(match[0]);
    const end = start + url.length;
    const safeHref = readerHref(url, sourceLinks);
    if (
      safeHref === undefined ||
      reserved.some((anchor) => anchor.end > start && anchor.start < end)
    ) {
      continue;
    }
    anchors.push({
      end,
      key: `bare-url-${String(start)}`,
      render: (children) => (
        <a
          className="text-primary decoration-primary/60 hover:decoration-primary underline underline-offset-2"
          href={readerHref(url, sourceLinks)}
          rel="noopener noreferrer"
          target="_blank"
        >
          {children}
        </a>
      ),
      start,
    });
  }
  return anchors;
};

export const InlineContent = ({
  activeMatchIndex,
  anchorPresentation = "document",
  anchors = NO_ANCHORS,
  initialOffset = 0,
  inlines,
  pieceId,
  ranges,
}: {
  activeMatchIndex: number;
  anchorPresentation?: AnchorPresentation | undefined;
  anchors?: TextAnchor[] | undefined;
  /** Offset of this inline slice within the complete search piece. */
  initialOffset?: number | undefined;
  inlines: Inline[];
  pieceId: string;
  ranges: ReaderMarkRange[];
}) => {
  const sourceLinks = useSourceLinkPolicy();
  const offset: OffsetRef = { value: initialOffset };
  const automaticLinks = bareUrlAnchors(
    inlinesToPlainText(inlines),
    anchors,
    initialOffset,
    sourceLinks,
  );
  const context: HighlightContext = {
    anchorPresentation,
    anchors: [...anchors, ...automaticLinks].toSorted(
      (left, right) => left.start - right.start,
    ),
    pieceId,
    ranges,
    activeMatchIndex,
    sourceLinks,
  };

  return <>{renderInlineChildren({ children: inlines, context, offset })}</>;
};

export const HighlightedText = ({
  activeMatchIndex,
  className,
  pieceId,
  ranges,
  segmentStart = 0,
  text,
}: {
  activeMatchIndex: number;
  className?: string | undefined;
  pieceId: string;
  ranges: ReaderMarkRange[];
  /** Offset of this slice within the complete search piece. */
  segmentStart?: number | undefined;
  text: string;
}) => (
  <span className={className}>
    {renderHighlightedSlice({
      activeMatchIndex,
      pieceId,
      ranges,
      segmentStart,
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
    2: "mt-[var(--reader-section-gap-top)] mb-[var(--reader-section-gap-bottom)] text-center text-[calc(0.95rem*var(--reader-text-scale))] leading-snug font-bold tracking-wider",
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
    1: "mt-[var(--reader-heading-gap-1)] mb-[var(--reader-heading-gap-bottom)] text-center text-[calc(1.35rem*var(--reader-text-scale))] leading-tight font-bold tracking-widest first:mt-0",
    2: "mt-[var(--reader-heading-gap-2)] mb-[var(--reader-heading-gap-bottom)] text-center text-[calc(1.25rem*var(--reader-text-scale))] leading-snug font-bold tracking-wide",
    3: "mt-[var(--reader-heading-gap-3)] mb-[var(--reader-heading-gap-bottom)] text-center text-[calc(1.15rem*var(--reader-text-scale))] leading-snug font-bold",
    4: "mt-[var(--reader-heading-gap-4)] mb-[var(--reader-heading-gap-bottom)] text-center text-[calc(1.15rem*var(--reader-text-scale))] leading-snug font-bold",
    5: "mt-[var(--reader-heading-gap-5)] mb-[var(--reader-heading-gap-bottom)] text-center text-[calc(1.05rem*var(--reader-text-scale))] leading-snug font-semibold",
    6: "mt-[var(--reader-heading-gap-6)] mb-[var(--reader-heading-gap-bottom)] text-center text-[calc(1rem*var(--reader-text-scale))] leading-snug font-semibold",
  },
} as const satisfies Record<ReaderVariant, Record<HeadingLevel, string>>;

const PARAGRAPH_LIST_INDENT_CLASS = {
  1: "ms-4 sm:ms-8",
  2: "ms-8 sm:ms-16",
  3: "ms-12 sm:ms-24",
  4: "ms-16 sm:ms-32",
} as const satisfies Record<ParagraphListDepth, string>;

/**
 * Where the glyph sits. A left-aligned block hangs it in the margin at the
 * edge its text starts from; a heading sets it in the row with its own words,
 * because a centred designation starts nowhere near that margin.
 */
type PermalinkPlacement = "hanging" | "inline";

const PERMALINK_PLACEMENT_CLASS = {
  hanging: "absolute end-full top-0 me-1",
  inline: "ms-1",
} as const satisfies Record<PermalinkPlacement, string>;

/**
 * A block's own address, as a link the reader can take with them.
 *
 * A plain click copies the link and writes the hash with `replaceState`: the
 * address bar and `:target` follow the block the reader pointed at, without
 * the browser scrolling it out from under them. The `href` stays a real one,
 * so a modified click, "copy link address" and middle-click still navigate.
 */
const BlockPermalink = ({
  anchorId,
  placement = "hanging",
}: {
  anchorId: string;
  placement?: PermalinkPlacement;
}) => {
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
      className={cn(
        "text-foreground-disabled hover:text-foreground focus-visible:ring-ring rounded-sm px-1 leading-[inherit] no-underline opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none print:hidden [@media(hover:none)]:opacity-100",
        PERMALINK_PLACEMENT_CLASS[placement],
      )}
      data-reader-chrome=""
      href={`#${anchorId}`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        window.history.replaceState(null, "", `#${anchorId}`);
        detached(copyPermalink(), "legal-reader.permalink-copy");
      }}
    >
      ¶
    </a>
  );
};

const REGEXP_SPECIALS_RE = /[.*+?^${}()|[\]\\]/gu;

/**
 * Whether a footnote's text already opens with its own label ("[3] …",
 * "3) …"). Sources differ: Word-derived corpora keep the mark inside the
 * footnote body, structured corpora strip it — the reader shows its own
 * label only when the text does not.
 */
/**
 * From a footnote back to the sentence that cites it: scroll the first
 * in-text reference into view and flash its paragraph.
 */
const jumpToNoteReference = (anchorId: string) => {
  // :not([data-reader-chrome]) keeps the block's own permalink — which
  // shares the href — from matching instead of the in-text reference.
  const ref = document.querySelector<HTMLElement>(
    `a[href="#${CSS.escape(anchorId)}"]:not([data-reader-chrome])`,
  );
  if (!ref) {
    return;
  }
  ref.scrollIntoView({ behavior: "instant", block: "center" });
  const blockEl = ref.closest<HTMLElement>("[data-anchor]");
  if (!blockEl) {
    return;
  }
  delete blockEl.dataset["highlight"];
  forceReflow(blockEl);
  blockEl.dataset["highlight"] = "";
};

/**
 * The return arrow at the end of a footnote: jumps back to the sentence
 * that cites it, mirroring the clickable footnote number. `headAnchorId`
 * is the footnote's first part, the anchor the in-text reference names;
 * the caller that groups a footnote's parts supplies it.
 */
const NoteBackJump = ({ headAnchorId }: { headAnchorId: string }) => {
  const t = useTranslations();
  return (
    <button
      aria-label={t("common.back")}
      className="reader-note-back"
      data-reader-chrome=""
      onClick={() => jumpToNoteReference(headAnchorId)}
      title={t("common.back")}
      type="button"
    >
      {"\u21B5"}
    </button>
  );
};

const footnoteTextCarriesLabel = (
  label: string,
  plainText: string,
): boolean => {
  // Nothing to draw: a mark the source did not print adds no information,
  // and an empty button is an invisible click target.
  if (label === "") {
    return true;
  }
  const escaped = label.replace(REGEXP_SPECIALS_RE, (match) => `\\${match}`);
  // The label must end at a boundary: closing punctuation, or anything that
  // is not a letter or digit. Without it, label "1" would swallow a note
  // that merely begins with "1954".
  return new RegExp(
    `^\\s*[\\[(]?${escaped}(?:[\\]).:]|(?![\\p{L}\\p{N}]))`,
    "u",
  ).test(plainText);
};

/** One line of a heading, with where it starts in the heading's plain text. */
type HeadingSlice = {
  initialOffset: number;
  inlines: Inline[];
};

/**
 * A heading cut around the line that states the provision designation: what
 * the publisher printed above it, the designation itself, and what follows.
 * Each slice carries its offset, so a search range stated over the whole
 * heading still highlights the right characters.
 */
type ProvisionHeadingSlices = {
  above: HeadingSlice;
  below: HeadingSlice;
  designation: HeadingSlice;
};

const headingSlice = (
  inlines: readonly Inline[],
  start: number,
  end: number,
): HeadingSlice => ({
  initialOffset: inlinesToPlainText(inlines.slice(0, start)).length,
  inlines: inlines.slice(start, end),
});

const provisionHeadingSlices = (
  inlines: readonly Inline[],
  designationLine: number,
): ProvisionHeadingSlices => {
  const breaks = inlines.flatMap((inline, index) =>
    inline.type === "line-break" ? [index] : [],
  );
  // The break that closes the preceding line, and the one that closes this
  // one; a designation on the first or last line has none on that side.
  const opening =
    designationLine === 0 ? -1 : (breaks[designationLine - 1] ?? -1);
  const closing = breaks[designationLine] ?? inlines.length;

  return {
    above: headingSlice(inlines, 0, Math.max(opening, 0)),
    below: headingSlice(inlines, closing + 1, inlines.length),
    designation: headingSlice(inlines, opening + 1, closing),
  };
};

export const BlockRenderer = ({
  activeMatchIndex,
  anchorPresentation = "document",
  anchorsByPieceId,
  block,
  headingPresentation,
  landing = false,
  noteBackJumpTo,
  noteHead = true,
  rangesByPieceId,
  variant,
}: {
  activeMatchIndex: number;
  anchorPresentation?: AnchorPresentation | undefined;
  anchorsByPieceId?: Record<string, TextAnchor[]> | undefined;
  block: Block;
  /**
   * A provision's designation is a row of its own — the designation at
   * reading size with an optional action beside it — and the title the
   * publisher printed with it keeps its place above or below that row.
   * `designationLine` states which of the heading's lines the designation
   * is, because publishers state it in either order. Other headings keep
   * source layout.
   */
  headingPresentation?:
    | {
        accessory?: ReactNode | undefined;
        designationLine: number;
        type: "provision";
      }
    | undefined;
  /**
   * This is the block the reader was sent to. Unlike an arrival flash the
   * marker stays, so the passage is still findable after scrolling away and
   * back; the caller drops it when the reader jumps somewhere else.
   */
  landing?: boolean | undefined;
  /**
   * Render the return arrow: this is the last paragraph of a footnote, and
   * the value is the anchor of its first paragraph, where the jump lands.
   */
  noteBackJumpTo?: string | undefined;
  /**
   * Render the note's label: this is the first paragraph of a footnote.
   * A reader that does not group a footnote's parts leaves this alone,
   * and every footnote paragraph is treated as its own first part.
   */
  noteHead?: boolean | undefined;
  rangesByPieceId: Record<string, ReaderMarkRange[]>;
  variant: ReaderVariant;
}) => {
  const documentAnchorProps = {
    "data-anchor": block.anchorId,
    "data-reader-landing": landing ? "" : undefined,
    id: anchorPresentation === "document" ? block.anchorId : undefined,
  };
  const isAddressable = anchorPresentation === "document";
  const permalink = isAddressable ? (
    <BlockPermalink anchorId={block.anchorId} />
  ) : null;
  const headingPermalink = isAddressable ? (
    <BlockPermalink anchorId={block.anchorId} placement="inline" />
  ) : null;

  if (block.type === "heading") {
    const Tag = `h${block.level}` as const;
    const provision =
      headingPresentation?.type === "provision"
        ? {
            accessory: headingPresentation.accessory,
            ...provisionHeadingSlices(
              block.inlines,
              headingPresentation.designationLine,
            ),
          }
        : null;
    const sharedInlineProps = {
      activeMatchIndex,
      anchorPresentation,
      anchors: anchorsForPiece(anchorsByPieceId, block.id),
      pieceId: block.id,
      ranges: rangesForPiece(rangesByPieceId, block.id),
    };

    return (
      <Tag
        className={cn(
          "group relative scroll-mt-[var(--reader-anchor-offset)]",
          HEADING_CLASS[variant][block.level],
          provision !== null &&
            "text-[calc(1rem*var(--reader-text-scale))] leading-snug font-semibold tracking-normal",
        )}
        {...documentAnchorProps}
      >
        {provision === null ? (
          <>
            <InlineContent {...sharedInlineProps} inlines={block.inlines} />
            {/* Zero-width, so the glyph hangs after the last word without
                pulling a centred line off the column's axis. */}
            {headingPermalink !== null && (
              <span className="inline-block w-0 whitespace-nowrap">
                {headingPermalink}
              </span>
            )}
          </>
        ) : (
          <>
            {provision.above.inlines.length > 0 && (
              <span className="mb-3 block">
                <InlineContent
                  {...sharedInlineProps}
                  initialOffset={provision.above.initialOffset}
                  inlines={provision.above.inlines}
                />
              </span>
            )}
            {/* Two equal side tracks keep the designation on the column's
                axis however wide the accessory is. A column too narrow for
                a localized action beside it stacks the actions below, so
                they never overlap the designation or leave the pane. */}
            <span className="@container/provision block">
              <span className="grid grid-cols-1 justify-items-center gap-2 @lg/provision:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] @lg/provision:gap-3">
                <span
                  aria-hidden="true"
                  className="hidden @lg/provision:block"
                />
                <span className="text-foreground text-[calc(1.35rem*var(--reader-text-scale))] leading-none font-medium">
                  <InlineContent
                    {...sharedInlineProps}
                    initialOffset={provision.designation.initialOffset}
                    inlines={provision.designation.inlines}
                  />
                </span>
                <span className="flex min-w-0 flex-wrap items-center justify-center gap-2 text-base @lg/provision:justify-self-start">
                  {provision.accessory}
                  {headingPermalink}
                </span>
              </span>
            </span>
            {provision.below.inlines.length > 0 && (
              <span className="mt-3 block">
                <InlineContent
                  {...sharedInlineProps}
                  initialOffset={provision.below.initialOffset}
                  inlines={provision.below.inlines}
                />
              </span>
            )}
          </>
        )}
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
    const nonJustifiedRoles = new Set([
      "case-number",
      "closing",
      "signature",
      "parties",
      "front-matter",
    ]);
    const shouldJustify =
      !isRomanNumeralDivider &&
      (block.role === undefined || !nonJustifiedRoles.has(block.role));
    const noteLabel = block.note?.type === "footnote" ? block.note.label : null;
    const showNoteLabel =
      noteHead &&
      noteLabel !== null &&
      !footnoteTextCarriesLabel(noteLabel, block.plainText);
    return (
      <p
        className={cn(
          "group relative mb-[var(--reader-paragraph-gap)] scroll-mt-[var(--reader-anchor-offset)] last:mb-0",
          shouldJustify && "reader-justify",
          block.role === "holding" && "font-[520]",
          // Indented, slightly condensed; never italicized or reflowed —
          // a reproduced passage must not be visually altered.
          block.role === "quote" &&
            "border-border my-4 border-s-2 ps-5 text-[0.95em]",
          // Reporter front matter keeps its published, centered shape.
          block.role === "parties" &&
            "my-4 text-center text-[1.05em] leading-relaxed tracking-wide",
          block.role === "front-matter" &&
            "text-muted-foreground my-1 text-center text-[0.95em]",
          block.note?.type === "footnote" &&
            "text-muted-foreground mb-2 text-[0.86em] leading-relaxed",
          isRomanNumeralDivider &&
            "mt-[var(--reader-section-gap-top)] mb-[var(--reader-section-gap-bottom)] text-center text-sm font-semibold",
          block.role === "case-number" &&
            "reader-chrome text-muted-foreground mb-2 text-end text-[calc(0.95rem*var(--reader-text-scale))]",
          block.role === "closing" && "mt-8 text-center",
          block.role === "signature" &&
            "reader-signature text-muted-foreground mt-1 text-end",
          block.listDepth !== undefined &&
            PARAGRAPH_LIST_INDENT_CLASS[block.listDepth],
          // Courts that number their paragraphs are cited by that
          // number, so it hangs in the margin rather than running into
          // the sentence, the way the published decision prints it.
          block.number !== undefined && "ps-8",
        )}
        {...documentAnchorProps}
        data-note={block.note?.type}
      >
        {permalink}
        {showNoteLabel && !isAddressable && (
          // The reference the label jumps back to is not in an excerpt.
          <span className="reader-note-label" data-reader-chrome="">
            {noteLabel}
          </span>
        )}
        {showNoteLabel && isAddressable && (
          <button
            className="reader-note-label"
            data-reader-chrome=""
            onClick={() => jumpToNoteReference(block.anchorId)}
            type="button"
          >
            {noteLabel}
          </button>
        )}
        {block.number !== undefined && (
          <HighlightedText
            activeMatchIndex={activeMatchIndex}
            className="reader-chrome text-muted-foreground absolute start-0 text-[0.8em] select-none"
            data-reader-chrome=""
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
          anchorPresentation={anchorPresentation}
          anchors={anchorsForPiece(anchorsByPieceId, block.id)}
          inlines={block.inlines}
          pieceId={block.id}
          ranges={rangesForPiece(rangesByPieceId, block.id)}
        />
        {noteBackJumpTo !== undefined && block.note?.type === "footnote" && (
          <NoteBackJump headAnchorId={noteBackJumpTo} />
        )}
      </p>
    );
  }

  // A figure the publisher printed with the document. `alt` is whatever the
  // source labelled it with, and an empty string when it labelled it with
  // nothing — which is the correct markup for decoration a screen reader
  // should skip, not a gap to fill with invented words.
  if (block.type === "image") {
    return (
      <figure
        className="group relative my-4 scroll-mt-[var(--reader-anchor-offset)]"
        {...documentAnchorProps}
      >
        {permalink}
        <img
          alt={block.alt ?? ""}
          className="mx-auto h-auto max-w-full"
          decoding="async"
          height={block.height}
          loading="lazy"
          src={block.src}
          width={block.width}
        />
      </figure>
    );
  }

  // The permalink is a link, and a link is not allowed inside `<table>`, so
  // the wrapper carries it. The anchor id stays on the table itself: it is
  // what every deep link already written points at.
  return (
    // A court's table has the columns it has, and a narrow reader (the
    // inspector pane at its minimum) cannot always hold them. It scrolls
    // inside its own box rather than widening the pane, and never on paper,
    // where the page is as wide as it will ever be.
    <div className="group relative max-w-full overflow-x-auto print:overflow-x-visible">
      {permalink}
      <table
        className="reader-chrome my-4 w-full border-collapse scroll-mt-[var(--reader-anchor-offset)] text-[calc(0.88rem*var(--reader-text-scale))]"
        {...documentAnchorProps}
      >
        <tbody>
          {block.rows.map((row, rowIndex) => (
            // oxlint-disable-next-line react/no-array-index-key -- read-only case-law document table parsed once from source text; rows are positionally fixed (rowIndex feeds tableCellPieceId's identity below) and never reordered/inserted by the reader UI.
            <tr key={rowIndex}>
              {row.map((cell, columnIndex) => {
                const pieceId = tableCellPieceId({
                  blockId: block.id,
                  rowIndex,
                  columnIndex,
                });
                const Cell = cell.header ? "th" : "td";

                return (
                  <Cell
                    className={cn(
                      "border-border/55 border-b px-3 py-1 align-top last:border-b-0",
                      cell.header && "text-start font-semibold",
                    )}
                    colSpan={cell.colSpan}
                    // A cell's words are their own piece with their own
                    // offsets, so a mark left in one is anchored to the cell.
                    // The table around it is a container: `selectionAnchorsFrom`
                    // takes the innermost anchored element, so the two never
                    // both claim the same selection.
                    data-anchor={pieceId}
                    key={pieceId}
                    rowSpan={cell.rowSpan}
                  >
                    <InlineContent
                      activeMatchIndex={activeMatchIndex}
                      anchorPresentation={anchorPresentation}
                      anchors={anchorsForPiece(anchorsByPieceId, pieceId)}
                      inlines={cell.inlines}
                      pieceId={pieceId}
                      ranges={rangesForPiece(rangesByPieceId, pieceId)}
                    />
                  </Cell>
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
  anchorsByPieceId,
  rangesByPieceId,
  text,
}: {
  activeMatchIndex: number;
  anchorsByPieceId?: Record<string, TextAnchor[]> | undefined;
  rangesByPieceId: Record<string, ReaderMarkRange[]>;
  text: string;
}) => {
  const paragraphs = text.split(/\n{2,}/u);

  return (
    <>
      {paragraphs.map((paragraph, index) => {
        const pieceId = `fulltext:${index}`;

        return (
          <p
            className="reader-justify mb-[var(--reader-paragraph-gap)] last:mb-0"
            data-anchor={pieceId}
            id={pieceId}
            key={pieceId}
          >
            <InlineContent
              activeMatchIndex={activeMatchIndex}
              anchors={anchorsForPiece(anchorsByPieceId, pieceId)}
              inlines={[{ text: paragraph, type: "text" }]}
              pieceId={pieceId}
              ranges={rangesForPiece(rangesByPieceId, pieceId)}
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
    // A figure's only text is its alt, which is chrome for a screen
    // reader rather than the document's words: a find-bar hit on it
    // would scroll to a picture with nothing highlighted in it.
    if (block.type === "image") {
      continue;
    }

    if (block.type === "table") {
      for (const [rowIndex, row] of block.rows.entries()) {
        for (const [columnIndex, cell] of row.entries()) {
          pieces.push({
            id: tableCellPieceId({
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

/**
 * Every search piece one block renders, in the order
 * `buildDocumentAstSearchPieces` writes them. Derived from that builder's own
 * shapes rather than restated, so a new kind of piece cannot go missing here.
 */
const blockSearchPieceIds = (block: Block): string[] =>
  buildDocumentAstSearchPieces([block]).map((piece) => piece.id);

/** The lowest match index among one block's search pieces, or null for none. */
const firstMatchIndexInBlock = (
  block: Block,
  rangesByPieceId: Record<string, SearchMatchRange[]>,
): number | null => {
  let first: number | null = null;
  for (const pieceId of blockSearchPieceIds(block)) {
    for (const { matchIndex } of rangesForPiece(rangesByPieceId, pieceId)) {
      first = first === null ? matchIndex : Math.min(first, matchIndex);
    }
  }
  return first;
};

/**
 * The find's first match inside the passage an anchor names, as an index into
 * the document's matches, or null when the query does not reach it.
 *
 * A passage is a run of blocks, not one block: the corpus indexes a
 * contiguous run of them as a single searchable unit and deep-links it by its
 * *first* member's anchor, so the words that won the hit may sit in a block
 * after the one named. The scan therefore walks forward from the anchor, and
 * stops at the next heading, which is where a passage ends — a heading closes
 * the run it follows rather than joining it. A section long enough to be
 * indexed as several passages has no heading between them, so the scan can
 * reach a match one passage further down the same section; that is a near
 * miss inside the section the reader asked for, where scanning the anchor
 * block alone lands them on an unrelated match at the top of the decision.
 * Naming the matching block exactly is the search result's job, not the
 * client's: nothing here can see the index's passage boundaries.
 *
 * Matches are numbered in document order, so the first block with any match
 * carries the one nearest the reader.
 */
export const firstMatchIndexInPassage = ({
  anchorId,
  blocks,
  rangesByPieceId,
}: {
  anchorId: string;
  blocks: readonly Block[];
  rangesByPieceId: Record<string, SearchMatchRange[]>;
}): number | null => {
  const start = blocks.findIndex((block) => block.anchorId === anchorId);
  if (start === -1) {
    return null;
  }

  for (const [offset, block] of blocks.slice(start).entries()) {
    // The anchor's own block counts even when it is a heading; a later one
    // ends the passage before it is read.
    if (offset > 0 && block.type === "heading") {
      return null;
    }
    const first = firstMatchIndexInBlock(block, rangesByPieceId);
    if (first !== null) {
      return first;
    }
  }
  return null;
};

/** Search pieces for the paragraph split `FulltextFallback` renders. */
export const buildFulltextSearchPieces = (text: string): SearchPiece[] =>
  text.split(/\n{2,}/u).map((paragraph, index) => ({
    id: `fulltext:${index}`,
    text: paragraph,
  }));
