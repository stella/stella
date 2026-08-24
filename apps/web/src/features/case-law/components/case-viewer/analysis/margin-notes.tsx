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

export type MarginItem = AnalysisMarginItem | CommentMarginItem;

type MarginNotesProps = {
  items: MarginItem[];
  scrollContainerRef: RefObject<HTMLElement | null>;
};

type PositionedItem = MarginItem & { top: number };

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
    const result: PositionedItem[] = [];
    let lastBottom = 0;

    for (const item of items) {
      const el = sc.querySelector(`#${CSS.escape(item.startAnchorId)}`);
      if (!el) {
        continue;
      }

      const elRect = el.getBoundingClientRect();
      let top = elRect.top - wrapperRect.top;

      const h = heights.get(item.id) ?? 48;
      if (top < lastBottom + 8) {
        top = lastBottom + 8;
      }

      result.push({ ...item, top });
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

  useExternalSyncEffect(() => {
    const sc = scrollContainerRef.current;
    if (!sc) {
      return undefined;
    }
    recalc();
    sc.addEventListener("scroll", recalc, { passive: true });
    globalThis.addEventListener("resize", recalc);
    return () => {
      sc.removeEventListener("scroll", recalc);
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

  return (
    <div className="absolute inset-0" ref={containerRef}>
      {positioned.map((item) =>
        item.kind === "comment" ? (
          <CommentNote
            item={item}
            key={item.id}
            measureRef={measureRef}
            onJump={() => scrollTo(item.startAnchorId)}
          />
        ) : (
          <AnalysisNote
            item={item}
            key={item.id}
            measureRef={measureRef}
            onJump={() => scrollTo(item.startAnchorId)}
          />
        ),
      )}
    </div>
  );
};

type NoteProps<T extends MarginItem> = {
  item: T & { top: number };
  measureRef: (el: HTMLElement | null, id: string) => void;
  onJump: () => void;
};

const AnalysisNote = ({
  item,
  measureRef,
  onJump,
}: NoteProps<AnalysisMarginItem>) => {
  const cssVar = getCategoryVar(item.category);

  return (
    <button
      className="text-foreground-muted hover:text-foreground-strong-muted absolute start-0 end-0 border-s-[3px] py-1 ps-2.5 text-start transition-colors"
      // oxlint-disable-next-line require-contained-handler/require-contained-handler -- measure callback ref, no portal-bearing descendants
      onClick={onJump}
      ref={(el) => measureRef(el, item.id)}
      style={{
        top: `${item.top}px`,
        paddingInlineStart: `${0.625 + item.depth * 0.5}rem`,
        borderInlineStartColor:
          item.kind === "card"
            ? `var(${cssVar})`
            : `color-mix(in srgb, var(${cssVar}) 60%, transparent)`,
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
 * A reader's comment: the avatar says whose it is, next to the AI's notes
 * that carry none. The author alone gets the controls.
 */
const CommentNote = ({
  item,
  measureRef,
  onJump,
}: NoteProps<CommentMarginItem>) => {
  const t = useTranslations();
  const shared = item.visibility === "shared";

  return (
    <div
      className="group/comment absolute start-0 end-0 border-s-[3px] py-1 ps-2.5"
      ref={(el) => measureRef(el, item.id)}
      style={{
        top: `${item.top}px`,
        borderInlineStartColor: "var(--option-sky)",
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
                ? t("caseLaw.annotations.visibilityPrivate")
                : t("caseLaw.annotations.visibilityShared")
            }
            render={
              <button
                aria-label={
                  shared
                    ? t("caseLaw.annotations.visibilityPrivate")
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
