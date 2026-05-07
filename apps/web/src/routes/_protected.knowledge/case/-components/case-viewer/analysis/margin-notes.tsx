/**
 * Margin notes positioned alongside their anchor paragraphs.
 *
 * "card" items have a heading + optional annotation text.
 * "annotation" items are standalone annotation summaries.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { getCategoryVar } from "./types";

const capitalize = (s: string): string =>
  s.charAt(0).toUpperCase() + s.slice(1);

export type MarginItem = {
  kind: "card" | "annotation";
  id: string;
  heading?: string | undefined;
  text: string;
  category: string;
  depth: number;
  startAnchorId: string;
};

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
  const heights = useRef(new Map<string, number>());

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

      const h = heights.current.get(item.id) ?? 48;
      if (top < lastBottom + 8) {
        top = lastBottom + 8;
      }

      result.push({ ...item, top });
      lastBottom = top + h;
    }

    setPositioned(result);
  }, [scrollContainerRef, items]);

  const measureRef = useCallback(
    (el: HTMLElement | null, id: string) => {
      if (!el) {
        return;
      }
      const h = el.offsetHeight;
      if (heights.current.get(id) !== h) {
        heights.current.set(id, h);
        requestAnimationFrame(recalc);
      }
    },
    [recalc],
  );

  useEffect(() => {
    const sc = scrollContainerRef.current;
    if (!sc) {
      return undefined;
    }
    recalc();
    sc.addEventListener("scroll", recalc, { passive: true });
    window.addEventListener("resize", recalc);
    return () => {
      sc.removeEventListener("scroll", recalc);
      window.removeEventListener("resize", recalc);
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
    void el.offsetWidth;
    el.dataset["highlight"] = "";
  };

  return (
    <div className="absolute inset-0" ref={containerRef}>
      {positioned.map((item) => {
        const cssVar = getCategoryVar(item.category);

        return (
          <button
            className="text-foreground-muted hover:text-foreground-strong-muted absolute start-0 end-0 border-s-[3px] py-1 ps-2.5 text-start transition-colors"
            key={item.id}
            onClick={() => scrollTo(item.startAnchorId)}
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
      })}
    </div>
  );
};
