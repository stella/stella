/**
 * Margin notes positioned alongside their anchor paragraphs.
 *
 * "card" items have a heading + optional annotation text.
 * "annotation" items are standalone annotation summaries.
 */

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { getCategoryVar } from "./types";

const capitalize = (s: string): string =>
  s.charAt(0).toUpperCase() + s.slice(1);

export type MarginItem = {
  kind: "card" | "annotation";
  id: string;
  heading?: string | undefined;
  text: string;
  category: string;
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
  const heights = useRef<Map<string, number>>(new Map());

  const recalc = useCallback(() => {
    const sc = scrollContainerRef.current;
    const wrapper = containerRef.current;
    if (!sc || !wrapper || items.length === 0) return;

    const wrapperRect = wrapper.getBoundingClientRect();
    const result: PositionedItem[] = [];
    let lastBottom = 0;

    for (const item of items) {
      const el = sc.querySelector(`#${CSS.escape(item.startAnchorId)}`);
      if (!el) continue;

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
      if (!el) return;
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
    if (!sc) return;
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
    if (!sc) return;
    const el = sc.querySelector(`#${CSS.escape(anchorId)}`);
    if (!el) return;
    const offset =
      el.getBoundingClientRect().top -
      sc.getBoundingClientRect().top +
      sc.scrollTop;
    sc.scrollTo({ top: offset, behavior: "instant" });
    el.removeAttribute("data-highlight");
    void (el as HTMLElement).offsetWidth;
    el.setAttribute("data-highlight", "");
  };

  return (
    <div className="absolute inset-0" ref={containerRef}>
      {positioned.map((item) => {
        const cssVar = getCategoryVar(item.category);

        return (
          <button
            className="text-foreground/60 hover:text-foreground/80 absolute left-0 right-0 border-l-[3px] py-1 pl-2.5 text-left transition-colors"
            key={item.id}
            onClick={() => scrollTo(item.startAnchorId)}
            ref={(el) => measureRef(el, item.id)}
            style={{
              top: `${item.top}px`,
              borderLeftColor: item.kind === "card"
                ? `var(${cssVar})`
                : `color-mix(in srgb, var(${cssVar}) 60%, transparent)`,
            }}
            type="button"
          >
            {item.heading && (
              <span className="text-foreground/80 mb-0.5 block text-[0.8rem] font-semibold leading-tight">
                {capitalize(item.heading)}
              </span>
            )}
            {item.text && (
              <span className="text-foreground/65 block text-[0.75rem] leading-snug">
                {item.text}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
