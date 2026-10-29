/**
 * Margin notes positioned alongside their exact text anchors.
 *
 * "card" items have a heading + optional annotation text, "annotation"
 * items are standalone AI annotation summaries, and "comment" items are a
 * reader's own words on a passage, signed with their avatar.
 */

import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { ReaderAnnotationTargetType } from "@stll/api-contract/legal-reader-annotations";
import type { CitedProvisionTarget } from "@stll/decision-reader/reader-types";
import { Button } from "@stll/ui/button";
import { Building2Icon, PenIcon, Trash2Icon } from "@stll/ui/icons";
import { Textarea } from "@stll/ui/textarea";
import { containedHandler } from "@stll/ui/use-contained-handler";
import { cn } from "@stll/ui/utils";

import { commentWasEdited } from "@/components/legal-reader/annotations/comment-edit";
import type { CommentEdit } from "@/components/legal-reader/annotations/comment-edit";
import { isPendingAnnotationId } from "@/components/legal-reader/annotations/use-optimistic-annotation-mutations";
import { CitedProvisionExpansion } from "@/components/legal-reader/cited-provision-link";
import Tooltip from "@/components/tooltip";
import { UserIdentity } from "@/components/user-avatar";
import {
  AnnotationVisibilityToggle,
  SHARED_LABEL_KEY,
} from "@/features/case-law/components/case-viewer/analysis/annotation-visibility-toggle";
import { ReaderAnswerCard } from "@/features/case-law/components/case-viewer/reader-answer-card";
import type { ReaderAnswerCardProps } from "@/features/case-law/components/case-viewer/reader-answer-card";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useRelativeTime } from "@/i18n/formatting-context";
import { forceReflow } from "@/lib/utils";

import type { AnchoredNote, NotePlacement } from "./margin-notes.logic";
import {
  gutterIsAvailable,
  notePlacementPresentation,
  placeGutterNotes,
  UNMEASURED_NOTE_HEIGHT_PX,
} from "./margin-notes.logic";

const capitalize = (s: string): string =>
  s.charAt(0).toUpperCase() + s.slice(1);

type AnalysisMarginItemBase = {
  id: string;
  heading?: string | undefined;
  /** The CSS custom property the note's stripe and leader are drawn in. */
  accentVar: string;
  depth: number;
  startAnchorId: string;
};

export type AnalysisMarginItem = AnalysisMarginItemBase &
  (
    | { kind: "card" | "annotation"; text: string }
    | {
        /**
         * The shape a note takes, shown before any analysis exists: the
         * category is real, the lines are placeholders. Never invented text
         * beside a real decision.
         */
        kind: "example";
        lines: readonly number[];
      }
  );

export type CommentMarginItem = {
  kind: "comment";
  id: string;
  text: string;
  startAnchorId: string;
  author: { image: string | null; name: string | null };
  /** When it was written and last changed, as ISO instants. */
  createdAt: string;
  updatedAt: string;
  /** The current reader wrote it, so they may change or remove it. */
  mine: boolean;
  /** What it sits on, which decides who a shared comment reaches. */
  targetType: ReaderAnnotationTargetType;
  visibility: "private" | "shared";
  onDelete: () => void;
  /**
   * Saves an edit of the words and visibility in one call, so the owner can
   * order the writes; absent where a comment is not editable.
   */
  onEdit?: ((edit: CommentEdit) => void) | undefined;
  onToggleVisibility: () => void;
};

/** A comment being written, beside the paragraph it will belong to. */
export type ComposerMarginItem = {
  kind: "composer";
  id: string;
  startAnchorId: string;
  /** What the comment will sit on, which decides who sharing reaches. */
  targetType: ReaderAnnotationTargetType;
  onCancel: () => void;
  onSubmit: (body: string, visibility: "private" | "shared") => void;
};

export type AnswerMarginItem = ReaderAnswerCardProps & {
  kind: "answer";
  id: string;
  startAnchorId: string;
};

export type ProvisionMarginItem = {
  kind: "provision";
  id: string;
  startAnchorId: string;
  citations: readonly CitedProvisionTarget[];
};

export type MarginItem =
  | AnalysisMarginItem
  | CommentMarginItem
  | ComposerMarginItem
  | AnswerMarginItem
  | ProvisionMarginItem;

type MarginNotesProps =
  | {
      items: MarginItem[];
      /** Painted into the reader's own margin, beside their anchors. */
      placement: "gutter";
      scrollContainerRef: RefObject<HTMLElement | null>;
    }
  | {
      items: MarginItem[];
      /** Drawn in the text's flow, under the paragraph they belong to. */
      placement: "inline";
    };

/**
 * The notes on a document, wherever the reader has room for them. The gutter
 * is the wide reader's; a pane too narrow for a second column takes the same
 * notes in the text's own flow.
 */
export const MarginNotes = (props: MarginNotesProps) => {
  switch (props.placement) {
    case "gutter": {
      return (
        <GutterNotes
          items={props.items}
          scrollContainerRef={props.scrollContainerRef}
        />
      );
    }
    case "inline": {
      return <InlineNotes items={props.items} />;
    }
    default: {
      props satisfies never;
      return panic(`Unhandled notes placement: ${String(props)}`);
    }
  }
};

/**
 * The notes under their paragraph, in reading order. Nothing is measured:
 * the note sits where the document puts it, so it cannot drift from its
 * anchor and needs no leader line back to it.
 */
const InlineNotes = ({ items }: { items: MarginItem[] }) => (
  <div className="reader-chrome" data-reader-chrome="">
    {items.map((item) => (
      <MarginNote item={item} key={item.id} placement={{ type: "inline" }} />
    ))}
  </div>
);

/**
 * One comment card in the text's flow, for a surface that lists comments and
 * no other note kind (a document's comment panel): it draws the comment card
 * alone, without the dispatch over every note kind.
 */
export const InlineCommentNote = ({ item }: { item: CommentMarginItem }) => (
  <div className="reader-chrome" data-reader-chrome="">
    <div className="contents" data-margin-note={item.kind}>
      <CommentNote
        item={item}
        placement={{ type: "inline" }}
        presence="normal"
      />
    </div>
  </div>
);

type PositionedItem = MarginItem & {
  top: number;
  /** Where the note's text anchor actually is; `top` may sit lower when
   * earlier notes pushed it down, or when the anchor sits above the region
   * the notes own. The gap is bridged by a leader line. */
  anchorTop: number;
};

/** A human comment belongs to the selected words, not merely their paragraph. */
// A hovered note's anchor carries `on`; leaving sets `off` instead of removing
// the attribute, so the reader's wash layer stays and fades out.
const NOTE_HOVER = { on: "on", off: "off" } as const;

const resolveItemAnchor = (
  scrollContainer: HTMLElement,
  item: MarginItem,
): HTMLElement | null => {
  if (item.kind === "comment") {
    const annotation = scrollContainer.querySelector<HTMLElement>(
      `[data-annotation-id="${CSS.escape(item.id)}"]`,
    );
    if (annotation !== null) {
      return annotation;
    }
  }
  return scrollContainer.querySelector<HTMLElement>(
    `[data-anchor="${CSS.escape(item.startAnchorId)}"], #${CSS.escape(item.startAnchorId)}`,
  );
};

const GutterNotes = ({
  items,
  scrollContainerRef,
}: {
  items: MarginItem[];
  scrollContainerRef: RefObject<HTMLElement | null>;
}) => {
  const [positioned, setPositioned] = useState<PositionedItem[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  // Lazy state singleton (mutated in place, identity stable): avoids both
  // the render-scope ref write (React Compiler bailout) and per-render
  // allocation.
  const [heights] = useState(() => new Map<string, number>());

  // Added/removed from scroll + resize listeners by reference.
  const recalc = useCallback(() => {
    const sc = scrollContainerRef.current;
    const wrapper = containerRef.current;
    if (!sc || !wrapper || items.length === 0) {
      return;
    }

    const wrapperRect = wrapper.getBoundingClientRect();
    const region = { width: wrapperRect.width };
    // The stylesheet collapses the gutter on narrow viewports; measuring it
    // rather than repeating the breakpoint keeps one owner for the decision.
    if (!gutterIsAvailable(region)) {
      // Already empty stays the same array: the scroll listener still runs
      // while the gutter is collapsed, and a fresh `[]` would re-render on
      // every frame of it.
      setPositioned((previous) => (previous.length === 0 ? previous : []));
      return;
    }

    const anchored: AnchoredNote<MarginItem>[] = [];
    for (const item of items) {
      const el = resolveItemAnchor(sc, item);
      if (!el) {
        continue;
      }
      anchored.push({
        anchorTop: el.getBoundingClientRect().top - wrapperRect.top,
        height: heights.get(item.id) ?? UNMEASURED_NOTE_HEIGHT_PX,
        note: item,
      });
    }

    const result: PositionedItem[] = [];
    for (const { anchorTop, note, top } of placeGutterNotes({
      notes: anchored,
      region,
    })) {
      result.push({ ...note, anchorTop, top });
    }
    setPositioned(result);
  }, [scrollContainerRef, items, heights]);

  const measureRef = (el: HTMLElement | null, id: string) => {
    if (!el) {
      return;
    }
    const h = el.offsetHeight;
    if (heights.get(id) !== h) {
      heights.set(id, h);
      // Commit measured placement before an activated answer's reveal frame.
      recalc();
    }
  };

  // Hovering annotated TEXT lights its notes and slightly dims the rest of
  // the margin, mirroring the note→text hover. One listener pair on the
  // scroll container (not one per paragraph); the hovered block is read
  // from the event target.
  const [textHoverAnchor, setTextHoverAnchor] = useState<string | null>(null);

  useExternalSyncEffect(() => {
    const sc = scrollContainerRef.current;
    if (!sc) {
      return undefined;
    }
    recalc();
    const onPointerOver = (event: Event) => {
      const target = event.target;
      const block =
        target instanceof Element ? target.closest("[data-anchor]") : null;
      setTextHoverAnchor(
        block instanceof HTMLElement ? (block.dataset["anchor"] ?? null) : null,
      );
    };
    const onPointerLeave = () => setTextHoverAnchor(null);
    sc.addEventListener("scroll", recalc, { passive: true });
    sc.addEventListener("pointerover", onPointerOver, { passive: true });
    sc.addEventListener("pointerleave", onPointerLeave, { passive: true });
    globalThis.addEventListener("resize", recalc);
    return () => {
      sc.removeEventListener("scroll", recalc);
      sc.removeEventListener("pointerover", onPointerOver);
      sc.removeEventListener("pointerleave", onPointerLeave);
      globalThis.removeEventListener("resize", recalc);
    };
  }, [scrollContainerRef, recalc]);

  const scrollTo = (item: MarginItem) => {
    const sc = scrollContainerRef.current;
    if (!sc) {
      return;
    }
    const el = resolveItemAnchor(sc, item);
    if (!el) {
      return;
    }
    const offset =
      el.getBoundingClientRect().top -
      sc.getBoundingClientRect().top +
      sc.scrollTop;
    sc.scrollTo({ top: offset, behavior: "instant" });
    delete el.dataset["highlight"];
    forceReflow(el);
    el.dataset["highlight"] = "";
  };

  // Hovering (or focusing) a note tints the paragraph it belongs to and
  // lights the note's leader line, so the reader sees what a note is about
  // without jumping to it.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const noteHover = (item: MarginItem, on: boolean) => {
    setHoveredId(on ? item.id : null);
    const sc = scrollContainerRef.current;
    const el = sc === null ? null : resolveItemAnchor(sc, item);
    if (!el) {
      return;
    }
    el.dataset["noteHover"] = on ? NOTE_HOVER.on : NOTE_HOVER.off;
  };

  const notePresence = (item: MarginItem): NotePresence => {
    if (textHoverAnchor === null || item.kind === "composer") {
      return "normal";
    }
    return item.startAnchorId === textHoverAnchor ? "highlighted" : "dimmed";
  };

  return (
    <div className="absolute inset-0" ref={containerRef}>
      {positioned.map((item) => {
        // A note pushed away from its paragraph gets a bracket bridging the
        // gap while the note is hovered: along the gutter from the
        // paragraph's edge down to the note's own top. Invisible otherwise —
        // a resting line in empty space reads as a stray glyph, not a link.
        // Clamped to the region: an anchor beside the layers above it would
        // otherwise draw the bracket straight across them.
        const from = Math.max(item.anchorTop, 0);
        const drift = item.top - from;
        if (
          (drift < 16 && item.kind !== "answer") ||
          item.kind === "composer"
        ) {
          return null;
        }
        if (hoveredId !== item.id && item.kind !== "answer") {
          return null;
        }
        const color =
          item.kind === "comment" ||
          item.kind === "answer" ||
          item.kind === "provision"
            ? "var(--option-sky)"
            : `var(${item.accentVar})`;
        return (
          <div
            className="pointer-events-none absolute end-0 opacity-90"
            key={`leader-${item.id}`}
            style={{ top: from + 8 }}
          >
            <div
              className="absolute end-0 top-0 h-0.5 w-3 rounded-full"
              style={{ backgroundColor: color }}
            />
            {drift >= 16 && (
              <div
                className="absolute end-2.5 top-0 w-px"
                style={{ backgroundColor: color, height: drift + 6 }}
              />
            )}
          </div>
        );
      })}
      {positioned.map((item) => (
        <MarginNote
          item={item}
          key={item.id}
          measureRef={measureRef}
          onHover={(on) => noteHover(item, on)}
          onJump={() => scrollTo(item)}
          placement={{ type: "gutter", top: item.top }}
          presence={notePresence(item)}
        />
      ))}
    </div>
  );
};

type MarginNoteProps = {
  item: MarginItem;
  measureRef?: ((el: HTMLElement | null, id: string) => void) | undefined;
  onHover?: ((on: boolean) => void) | undefined;
  onJump?: (() => void) | undefined;
  placement: NotePlacement;
  presence?: NotePresence | undefined;
};

/**
 * One note, in whichever of the two places the reader has room for it. The
 * wrapper draws no box of its own; it only marks the note's kind.
 */
const MarginNote = (props: MarginNoteProps) => (
  // `MARGIN_NOTE_KIND_ATTRIBUTE`, which the notes column's click reads.
  <div className="contents" data-margin-note={props.item.kind}>
    <MarginNoteBody {...props} />
  </div>
);

const MarginNoteBody = ({
  item,
  measureRef,
  onHover,
  onJump,
  placement,
  presence = "normal",
}: MarginNoteProps) => {
  const observeSize = (el: HTMLElement | null) => {
    if (el === null || measureRef === undefined) {
      return undefined;
    }
    measureRef(el, item.id);
    const observer = new ResizeObserver(() => measureRef(el, item.id));
    observer.observe(el);
    return () => observer.disconnect();
  };

  switch (item.kind) {
    case "provision": {
      const position = notePlacementPresentation(placement);
      return (
        <div
          className={position.className}
          style={position.style}
          ref={observeSize}
        >
          <CitedProvisionExpansion
            citations={item.citations}
            placement={placement.type}
          />
        </div>
      );
    }
    case "answer": {
      const position = notePlacementPresentation(placement);
      return (
        <div
          className={position.className}
          style={position.style}
          ref={observeSize}
          onMouseEnter={() => onHover?.(true)}
          onMouseLeave={() => onHover?.(false)}
        >
          <ReaderAnswerCard {...item} />
        </div>
      );
    }
    case "comment": {
      return (
        <CommentNote
          item={item}
          measureRef={measureRef}
          onHover={onHover}
          onJump={onJump}
          placement={placement}
          presence={presence}
        />
      );
    }
    case "composer": {
      return (
        <ComposerNote
          draft={NEW_COMMENT_DRAFT}
          item={item}
          measureRef={measureRef}
          placement={placement}
        />
      );
    }
    case "example": {
      return (
        <ExampleNote
          item={item}
          measureRef={measureRef}
          placement={placement}
          presence={presence}
        />
      );
    }
    case "card":
    case "annotation": {
      return (
        <AnalysisNote
          item={item}
          measureRef={measureRef}
          onHover={onHover}
          onJump={onJump}
          placement={placement}
          presence={presence}
        />
      );
    }
    default: {
      item satisfies never;
      return panic(`Unhandled item: ${String(item)}`);
    }
  }
};

type NotePresence = "normal" | "highlighted" | "dimmed";

type NoteProps<T extends MarginItem> = {
  item: T;
  /** Gutter only: the note's own height decides where the next one starts. */
  measureRef?: ((el: HTMLElement | null, id: string) => void) | undefined;
  onHover?: ((on: boolean) => void) | undefined;
  /** Gutter only: an inline note already sits at its anchor. */
  onJump?: (() => void) | undefined;
  placement: NotePlacement;
  /** Reverse hover: the reader's pointer is on annotated text — its own
   * notes light up, every other note steps back. */
  presence: NotePresence;
};

type AnalysisNoteStyleOptions = {
  item: AnalysisMarginItem;
  placement: NotePlacement;
  presence: NotePresence;
};

/** The stripe, indent and position an analysis-shaped note is drawn with. */
const analysisNoteStyle = ({
  item,
  placement,
  presence,
}: AnalysisNoteStyleOptions) => {
  const cssVar = item.accentVar;
  // Reverse hover speaks through the colour stripe alone — the words stay
  // readable in every state. Dimmed washes the stripe out; highlighted goes
  // full colour, doubled by an inset glow.
  const stripe = (() => {
    if (presence === "dimmed") {
      return `color-mix(in srgb, var(${cssVar}) 22%, transparent)`;
    }
    if (
      presence === "highlighted" ||
      item.kind === "card" ||
      item.kind === "example"
    ) {
      return `var(${cssVar})`;
    }
    return `color-mix(in srgb, var(${cssVar}) 60%, transparent)`;
  })();

  return {
    ...notePlacementPresentation(placement).style,
    paddingInlineStart: `${0.625 + item.depth * 0.5}rem`,
    borderInlineStartColor: stripe,
    ...(presence === "highlighted" && {
      boxShadow: `inset 2px 0 0 var(${cssVar})`,
    }),
  };
};

const NoteHeading = ({ heading }: { heading: string | undefined }) =>
  heading ? (
    <span className="text-foreground-strong-muted mb-0.5 block text-[calc(0.8rem*var(--reader-text-scale))] leading-tight font-semibold">
      {capitalize(heading)}
    </span>
  ) : null;

/**
 * The shape a note would take, before there is an analysis. Decorative: its
 * lines are placeholders at seeded paragraphs, so it is neither focusable nor
 * announced, and there is nothing to jump to. The invitation's button is the
 * keyboard path to the offer.
 */
const ExampleNote = ({
  item,
  measureRef,
  placement,
  presence,
}: Omit<
  NoteProps<Extract<AnalysisMarginItem, { kind: "example" }>>,
  "onHover" | "onJump"
>) => (
  <div
    aria-hidden
    className={cn(
      "text-foreground-muted border-s-[3px] py-1 ps-2.5 text-start",
      notePlacementPresentation(placement).className,
    )}
    ref={(el) => measureRef?.(el, item.id)}
    style={analysisNoteStyle({ item, placement, presence })}
  >
    <NoteHeading heading={item.heading} />
    <span className="mt-1 flex flex-col gap-1.5">
      {item.lines.map((width) => (
        <span
          className="bg-muted block h-2 rounded-full"
          key={width}
          style={{ width: `${width * 100}%` }}
        />
      ))}
    </span>
  </div>
);

const AnalysisNote = ({
  item,
  measureRef,
  onHover,
  onJump,
  placement,
  presence,
}: NoteProps<Extract<AnalysisMarginItem, { kind: "card" | "annotation" }>>) => {
  const position = notePlacementPresentation(placement);
  const style = analysisNoteStyle({ item, placement, presence });
  const body = (
    <>
      <NoteHeading heading={item.heading} />
      {item.text && (
        <span className="text-foreground-placeholder block text-[calc(0.75rem*var(--reader-text-scale))] leading-snug">
          {item.text}
        </span>
      )}
    </>
  );

  // An inline note already sits at its anchor, so there is nowhere to jump:
  // it is read, not operated. A button here would take a tab stop and
  // announce an action that does nothing.
  if (onJump === undefined) {
    return (
      <div
        className={cn(
          "text-foreground-muted border-s-[3px] py-1 ps-2.5 text-start",
          position.className,
        )}
        ref={(el) => measureRef?.(el, item.id)}
        style={style}
      >
        {body}
      </div>
    );
  }

  return (
    <button
      className={cn(
        "text-foreground-muted hover:text-foreground-strong-muted border-s-[3px] py-1 ps-2.5 text-start",
        position.className,
      )}
      onBlur={() => onHover?.(false)}
      // oxlint-disable-next-line require-contained-handler/require-contained-handler -- measure callback ref, no portal-bearing descendants
      onClick={onJump}
      onFocus={containedHandler(null, () => onHover?.(true))}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      ref={(el) => measureRef?.(el, item.id)}
      style={style}
      type="button"
    >
      {body}
    </button>
  );
};

/** What the composer opens with: a blank comment, or one being edited. */
type ComposerDraft =
  | { type: "new" }
  | {
      type: "edit";
      body: string;
      visibility: "private" | "shared";
      /** Emptied words do not save; the author removes the comment instead. */
      onDelete: () => void;
    };

const NEW_COMMENT_DRAFT = { type: "new" } as const satisfies ComposerDraft;

/**
 * The comment being written, in the margin beside its paragraph so the text
 * stays uncovered. Enter (with or without Cmd or Ctrl) sends, Shift+Enter
 * breaks a line, Escape cancels.
 */
const ComposerNote = ({
  draft,
  item,
  measureRef,
  placement,
}: {
  draft: ComposerDraft;
  item: ComposerMarginItem;
  measureRef?: ((el: HTMLElement | null, id: string) => void) | undefined;
  placement: NotePlacement;
}) => {
  const t = useTranslations();
  const position = notePlacementPresentation(placement);
  const [body, setBody] = useState(draft.type === "edit" ? draft.body : "");
  const [visibility, setVisibility] = useState<"private" | "shared">(
    draft.type === "edit" ? draft.visibility : "private",
  );
  const empty = body.trim() === "";
  const submit = () => {
    const trimmed = body.trim();
    if (trimmed !== "") {
      item.onSubmit(trimmed, visibility);
    }
  };

  return (
    <form
      className={cn(
        "flex flex-col gap-1.5 border-s-[3px] py-1 ps-2.5 pe-2",
        position.className,
      )}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      ref={(el) => measureRef?.(el, item.id)}
      style={{
        ...position.style,
        borderInlineStartColor: "var(--option-sky)",
      }}
    >
      <Textarea
        aria-label={t("folio.comment")}
        autoFocus
        className="min-h-14 text-xs"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            item.onCancel();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={t("legalReader.annotations.commentPlaceholder")}
        value={body}
      />
      <div className="flex items-center justify-between gap-1">
        <AnnotationVisibilityToggle
          targetType={item.targetType}
          visibility={visibility}
          onToggle={() =>
            setVisibility(visibility === "private" ? "shared" : "private")
          }
        />
        <div className="flex items-center gap-1">
          <Button
            className="text-2xs h-6 px-2"
            onClick={item.onCancel}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("common.cancel")}
          </Button>
          {/* An edit emptied of text deletes the comment; otherwise it saves. */}
          <Button
            className="text-2xs h-6 px-2"
            size="sm"
            {...(draft.type === "edit" && empty
              ? ({
                  onClick: draft.onDelete,
                  type: "button",
                  variant: "destructive-ghost",
                } as const)
              : ({ disabled: empty, type: "submit" } as const))}
          >
            {draft.type === "edit" && empty
              ? t("common.delete")
              : t("common.save")}
          </Button>
        </div>
      </div>
    </form>
  );
};

/** Says a comment changed after it was written, and when. */
const EditedMark = ({ updatedAt }: { updatedAt: string }) => {
  const t = useTranslations();
  const relativeTime = useRelativeTime();
  return (
    <span className="text-foreground-disabled text-[calc(0.7rem*var(--reader-text-scale))]">
      <Tooltip
        content={t("legalReader.annotations.editedAt", {
          time: relativeTime(updatedAt),
        })}
        render={<time dateTime={updatedAt} />}
      >
        {t("common.edited")}
      </Tooltip>
    </span>
  );
};

/**
 * A reader's comment: the avatar says whose it is, next to the AI's notes
 * that carry none. The author alone gets the controls.
 */
const CommentNote = ({
  item,
  measureRef,
  onHover,
  onJump,
  placement,
  presence,
}: NoteProps<CommentMarginItem>) => {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  // Leaving the editor hands focus back to the Edit button it came from; the
  // button mounts again only once the editor has gone.
  const refocusEdit = useRef(false);
  const shared = item.visibility === "shared";
  const position = notePlacementPresentation(placement);
  // A comment the server has not stored yet has no id to change or remove it
  // by; its controls appear once the create answers.
  const controllable = item.mine && !isPendingAnnotationId(item.id);
  const onEdit = controllable ? item.onEdit : undefined;

  if (editing && onEdit !== undefined) {
    const stopEditing = () => {
      refocusEdit.current = true;
      setEditing(false);
    };
    return (
      <ComposerNote
        draft={{
          type: "edit",
          body: item.text,
          visibility: item.visibility,
          onDelete: item.onDelete,
        }}
        item={{
          id: item.id,
          kind: "composer",
          startAnchorId: item.startAnchorId,
          targetType: item.targetType,
          onCancel: stopEditing,
          onSubmit: (body, visibility) => {
            if (body !== item.text || visibility !== item.visibility) {
              onEdit({ body, visibility });
            }
            stopEditing();
          },
        }}
        measureRef={measureRef}
        placement={placement}
      />
    );
  }

  const stripe =
    presence === "dimmed"
      ? "color-mix(in srgb, var(--option-sky) 22%, transparent)"
      : "var(--option-sky)";

  return (
    <div
      className={cn(
        "group/comment border-s-[3px] py-1 ps-2.5",
        position.className,
      )}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      ref={(el) => measureRef?.(el, item.id)}
      style={{
        ...position.style,
        borderInlineStartColor: stripe,
        ...(presence === "highlighted" && {
          boxShadow: "inset 2px 0 0 var(--option-sky)",
        }),
      }}
    >
      <div className="flex items-center gap-1.5">
        <UserIdentity
          avatarClassName="size-4 shrink-0 text-[0.55rem]"
          className="gap-1.5"
          image={item.author.image}
          name={item.author.name}
          nameClassName="text-foreground-strong-muted text-[calc(0.72rem*var(--reader-text-scale))] font-medium"
        />
        {shared && (
          <Tooltip
            content={t(SHARED_LABEL_KEY[item.targetType])}
            render={
              <span
                aria-label={t(SHARED_LABEL_KEY[item.targetType])}
                className="text-foreground-disabled"
              />
            }
          >
            <Building2Icon className="size-3" />
          </Tooltip>
        )}
        {commentWasEdited(item) && <EditedMark updatedAt={item.updatedAt} />}
      </div>
      {onJump === undefined ? (
        <p className="text-foreground-muted mt-0.5 text-start text-[calc(0.75rem*var(--reader-text-scale))] leading-snug">
          {item.text}
        </p>
      ) : (
        <button
          className="text-foreground-muted hover:text-foreground-strong-muted mt-0.5 block w-full text-start text-[calc(0.75rem*var(--reader-text-scale))] leading-snug"
          onClick={onJump}
          type="button"
        >
          {item.text}
        </button>
      )}
      {controllable && (
        <div
          className={cn(
            "mt-1 flex items-center gap-1 transition-opacity",
            // Inline is the layout a narrow pane and a touch screen get, where
            // there is no hover to reveal anything: a reader must be able to
            // reach their own comment's controls without a pointer.
            placement.type === "inline"
              ? "opacity-100"
              : "opacity-0 group-hover/comment:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100",
          )}
        >
          <AnnotationVisibilityToggle
            targetType={item.targetType}
            visibility={item.visibility}
            onToggle={item.onToggleVisibility}
          />
          {onEdit !== undefined && (
            <Tooltip
              content={t("legalReader.annotations.editComment")}
              render={
                <button
                  aria-label={t("legalReader.annotations.editComment")}
                  className="text-foreground-disabled hover:text-foreground rounded-sm p-0.5"
                  // The ref only returns focus; an icon has no portaled
                  // descendants to contain.
                  onClick={containedHandler(null, () => setEditing(true))}
                  ref={(button) => {
                    if (button !== null && refocusEdit.current) {
                      refocusEdit.current = false;
                      button.focus();
                    }
                  }}
                  type="button"
                />
              }
            >
              <PenIcon className="size-3" />
            </Tooltip>
          )}
          <Tooltip
            content={t("common.delete")}
            render={
              <button
                aria-label={t("common.delete")}
                className="text-foreground-disabled hover:text-destructive rounded-sm p-0.5"
                onClick={item.onDelete}
                type="button"
              />
            }
          >
            <Trash2Icon className="size-3" />
          </Tooltip>
        </div>
      )}
    </div>
  );
};
