/**
 * Margin notes positioned alongside their anchor paragraphs.
 *
 * "card" items have a heading + optional annotation text, "annotation"
 * items are standalone AI annotation summaries, and "comment" items are a
 * reader's own words on a passage, signed with their avatar.
 */

import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";

import { Building2Icon, LockIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Textarea } from "@stll/ui/textarea";
import { cn } from "@stll/ui/utils";

import Tooltip from "@/components/tooltip";
import { UserIdentity } from "@/components/user-avatar";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { forceReflow } from "@/lib/utils";

import { getCategoryVar } from "./types";

const capitalize = (s: string): string =>
  s.charAt(0).toUpperCase() + s.slice(1);

export type AnalysisMarginItem = {
  kind: "card" | "annotation";
  id: string;
  heading?: string | undefined;
  text: string;
  category: string;
  depth: number;
  startAnchorId: string;
};

export type CommentMarginItem = {
  kind: "comment";
  id: string;
  text: string;
  startAnchorId: string;
  author: { image: string | null; name: string | null };
  /** The current reader wrote it, so they may change or remove it. */
  mine: boolean;
  visibility: "private" | "shared";
  onDelete: () => void;
  onToggleVisibility: () => void;
};

/** A comment being written, beside the paragraph it will belong to. */
export type ComposerMarginItem = {
  kind: "composer";
  id: string;
  startAnchorId: string;
  onCancel: () => void;
  onSubmit: (body: string, visibility: "private" | "shared") => void;
};

export type MarginItem =
  | AnalysisMarginItem
  | CommentMarginItem
  | ComposerMarginItem;

type MarginNotesProps = {
  items: MarginItem[];
  scrollContainerRef: RefObject<HTMLElement | null>;
};

type PositionedItem = MarginItem & {
  top: number;
  /** Where the note's paragraph actually is; `top` may sit lower when
   * earlier notes pushed it down. The gap is bridged by a leader line. */
  anchorTop: number;
};

export const MarginNotes = ({
  items,
  scrollContainerRef,
}: MarginNotesProps) => {
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
    // Notes stack downwards from where their paragraph is, so they are laid
    // out in reading order regardless of the order they were handed in;
    // otherwise a later item (a comment being written) lands below every
    // earlier one instead of beside its own paragraph.
    const anchored: { item: MarginItem; anchorTop: number }[] = [];
    for (const item of items) {
      const el = sc.querySelector(`#${CSS.escape(item.startAnchorId)}`);
      if (!el) {
        continue;
      }
      anchored.push({
        item,
        anchorTop: el.getBoundingClientRect().top - wrapperRect.top,
      });
    }
    anchored.sort((a, b) => a.anchorTop - b.anchorTop);

    const result: PositionedItem[] = [];
    let lastBottom = 0;
    for (const { item, anchorTop } of anchored) {
      const h = heights.get(item.id) ?? 48;
      const top = Math.max(anchorTop, lastBottom + 8);
      result.push({ ...item, anchorTop, top });
      lastBottom = top + h;
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
      requestAnimationFrame(recalc);
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

  const scrollTo = (anchorId: string) => {
    const sc = scrollContainerRef.current;
    if (!sc) {
      return;
    }
    const el = sc.querySelector<HTMLElement>(`#${CSS.escape(anchorId)}`);
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
    const el = scrollContainerRef.current?.querySelector<HTMLElement>(
      `#${CSS.escape(item.startAnchorId)}`,
    );
    if (!el) {
      return;
    }
    if (on) {
      el.dataset["noteHover"] = "";
    } else {
      delete el.dataset["noteHover"];
    }
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
        const drift = item.top - item.anchorTop;
        if (drift < 16 || item.kind === "composer") {
          return null;
        }
        if (hoveredId !== item.id) {
          return null;
        }
        const color =
          item.kind === "comment"
            ? "var(--option-sky)"
            : `var(${getCategoryVar(item.category)})`;
        return (
          <div
            className="pointer-events-none absolute end-0 opacity-90"
            key={`leader-${item.id}`}
            style={{ top: item.anchorTop + 8 }}
          >
            <div
              className="absolute end-0 top-0 h-0.5 w-3 rounded-full"
              style={{ backgroundColor: color }}
            />
            <div
              className="absolute end-2.5 top-0 w-px"
              style={{ backgroundColor: color, height: drift + 6 }}
            />
          </div>
        );
      })}
      {positioned.map((item) => {
        switch (item.kind) {
          case "comment": {
            return (
              <CommentNote
                item={item}
                key={item.id}
                measureRef={measureRef}
                onHover={(on) => noteHover(item, on)}
                onJump={() => scrollTo(item.startAnchorId)}
                presence={notePresence(item)}
              />
            );
          }
          case "composer": {
            return (
              <ComposerNote item={item} key={item.id} measureRef={measureRef} />
            );
          }
          case "card":
          case "annotation": {
            return (
              <AnalysisNote
                item={item}
                key={item.id}
                measureRef={measureRef}
                onHover={(on) => noteHover(item, on)}
                onJump={() => scrollTo(item.startAnchorId)}
                presence={notePresence(item)}
              />
            );
          }
          default: {
            const unreachable: never = item;
            return unreachable;
          }
        }
      })}
    </div>
  );
};

type NotePresence = "normal" | "highlighted" | "dimmed";

type NoteProps<T extends MarginItem> = {
  item: T & { top: number };
  measureRef: (el: HTMLElement | null, id: string) => void;
  onHover: (on: boolean) => void;
  onJump: () => void;
  /** Reverse hover: the reader's pointer is on annotated text — its own
   * notes light up, every other note steps back. */
  presence: NotePresence;
};

const AnalysisNote = ({
  item,
  measureRef,
  onHover,
  onJump,
  presence,
}: NoteProps<AnalysisMarginItem>) => {
  const cssVar = getCategoryVar(item.category);
  // Reverse hover speaks through the colour stripe alone — the words stay
  // readable in every state. Dimmed washes the stripe out; highlighted goes
  // full colour, doubled by an inset glow.
  const stripe = (() => {
    if (presence === "dimmed") {
      return `color-mix(in srgb, var(${cssVar}) 22%, transparent)`;
    }
    if (presence === "highlighted" || item.kind === "card") {
      return `var(${cssVar})`;
    }
    return `color-mix(in srgb, var(${cssVar}) 60%, transparent)`;
  })();

  return (
    <button
      className="text-foreground-muted hover:text-foreground-strong-muted absolute start-0 end-0 border-s-[3px] py-1 ps-2.5 text-start transition-[color,border-color,box-shadow]"
      onBlur={() => onHover(false)}
      // oxlint-disable-next-line require-contained-handler/require-contained-handler -- measure callback ref, no portal-bearing descendants
      onClick={onJump}
      // oxlint-disable-next-line require-contained-handler/require-contained-handler -- measure callback ref, no portal-bearing descendants
      onFocus={() => onHover(true)}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      ref={(el) => measureRef(el, item.id)}
      style={{
        top: `${item.top}px`,
        paddingInlineStart: `${0.625 + item.depth * 0.5}rem`,
        borderInlineStartColor: stripe,
        ...(presence === "highlighted" && {
          boxShadow: `inset 2px 0 0 var(${cssVar})`,
        }),
      }}
      type="button"
    >
      {item.heading && (
        <span className="text-foreground-strong-muted mb-0.5 block text-[0.8rem] leading-tight font-semibold">
          {capitalize(item.heading)}
        </span>
      )}
      {item.text && (
        <span className="text-foreground-placeholder block text-[0.75rem] leading-snug">
          {item.text}
        </span>
      )}
    </button>
  );
};

/**
 * The comment being written, in the margin beside its paragraph so the text
 * stays uncovered. Enter sends, Shift+Enter breaks a line, Escape cancels.
 */
const ComposerNote = ({
  item,
  measureRef,
}: {
  item: ComposerMarginItem & { top: number };
  measureRef: (el: HTMLElement | null, id: string) => void;
}) => {
  const t = useTranslations();
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"private" | "shared">("private");
  const shared = visibility === "shared";
  const visibilityLabel = shared
    ? t("caseLaw.annotations.visibilityShared")
    : t("knowledge.agentSkills.scopePrivate");
  const submit = () => {
    const trimmed = body.trim();
    if (trimmed !== "") {
      item.onSubmit(trimmed, visibility);
    }
  };

  return (
    <form
      className="absolute start-0 end-0 flex flex-col gap-1.5 border-s-[3px] py-1 ps-2.5 pe-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      ref={(el) => measureRef(el, item.id)}
      style={{
        top: `${item.top}px`,
        borderInlineStartColor: "var(--option-sky)",
      }}
    >
      <Textarea
        aria-label={t("folio.comment")}
        autoFocus
        className="min-h-14 text-xs"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
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
        placeholder={t("caseLaw.annotations.commentPlaceholder")}
        value={body}
      />
      <div className="flex items-center justify-between gap-1">
        <Tooltip
          content={visibilityLabel}
          render={
            <button
              aria-label={visibilityLabel}
              aria-pressed={shared}
              className="text-foreground-disabled hover:text-foreground rounded-sm p-0.5"
              onClick={() => setVisibility(shared ? "private" : "shared")}
              type="button"
            />
          }
        >
          {shared ? (
            <Building2Icon className="size-3.5" />
          ) : (
            <LockIcon className="size-3.5" />
          )}
        </Tooltip>
        <div className="flex items-center gap-1">
          <Button
            className="h-6 px-2 text-[0.7rem]"
            onClick={item.onCancel}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("common.cancel")}
          </Button>
          <Button
            className="h-6 px-2 text-[0.7rem]"
            disabled={body.trim() === ""}
            size="sm"
            type="submit"
          >
            {t("common.save")}
          </Button>
        </div>
      </div>
    </form>
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
  presence,
}: NoteProps<CommentMarginItem>) => {
  const t = useTranslations();
  const shared = item.visibility === "shared";

  const stripe =
    presence === "dimmed"
      ? "color-mix(in srgb, var(--option-sky) 22%, transparent)"
      : "var(--option-sky)";

  return (
    <div
      className="group/comment absolute start-0 end-0 border-s-[3px] py-1 ps-2.5 transition-[border-color,box-shadow]"
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      ref={(el) => measureRef(el, item.id)}
      style={{
        top: `${item.top}px`,
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
          nameClassName="text-foreground-strong-muted text-[0.72rem] font-medium"
        />
        {shared && (
          <Tooltip
            content={t("caseLaw.annotations.visibilityShared")}
            render={
              <span
                aria-label={t("caseLaw.annotations.visibilityShared")}
                className="text-foreground-disabled"
              />
            }
          >
            <Building2Icon className="size-3" />
          </Tooltip>
        )}
      </div>
      <button
        className="text-foreground-muted hover:text-foreground-strong-muted mt-0.5 block w-full text-start text-[0.75rem] leading-snug transition-colors"
        onClick={onJump}
        type="button"
      >
        {item.text}
      </button>
      {item.mine && (
        <div
          className={cn(
            "mt-1 flex items-center gap-1 opacity-0 transition-opacity",
            "group-hover/comment:opacity-100 focus-within:opacity-100",
          )}
        >
          <Tooltip
            content={
              shared
                ? t("knowledge.agentSkills.scopePrivate")
                : t("caseLaw.annotations.visibilityShared")
            }
            render={
              <button
                aria-label={
                  shared
                    ? t("knowledge.agentSkills.scopePrivate")
                    : t("caseLaw.annotations.visibilityShared")
                }
                className="text-foreground-disabled hover:text-foreground rounded-sm p-0.5"
                onClick={item.onToggleVisibility}
                type="button"
              />
            }
          >
            {shared ? (
              <LockIcon className="size-3" />
            ) : (
              <Building2Icon className="size-3" />
            )}
          </Tooltip>
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
