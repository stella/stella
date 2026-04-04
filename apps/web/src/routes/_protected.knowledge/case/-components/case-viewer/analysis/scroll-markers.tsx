/**
 * Scrollbar heading markers.
 *
 * Single container on the right edge. Dots always visible.
 * Hover anywhere in the zone expands ticks and shows labels.
 * Click scrolls to heading. Wheel events pass through
 * naturally (no overflow on this element).
 */

import { type RefObject, useCallback, useEffect, useState } from "react";

import { cn } from "@stella/ui/lib/utils";

import { getCategoryVar } from "./types";

type HeadingMarker = {
  id: string;
  label: string;
  startAnchorId: string;
  category: string;
};

type ScrollMarkersProps = {
  headings: HeadingMarker[];
  scrollContainerRef: RefObject<HTMLElement | null>;
};

type Positioned = HeadingMarker & { pct: number; cssVar: string };

export const ScrollMarkers = ({
  headings,
  scrollContainerRef,
}: ScrollMarkersProps) => {
  const [markers, setMarkers] = useState<Positioned[]>([]);
  const [active, setActive] = useState(false);

  const recalc = useCallback(() => {
    const sc = scrollContainerRef.current;
    if (!sc || headings.length === 0) return;

    const scrollHeight = sc.scrollHeight;
    if (scrollHeight <= 0) return;

    const result: Positioned[] = [];

    for (const h of headings) {
      const el = sc.querySelector(`#${CSS.escape(h.startAnchorId)}`);
      if (!el) continue;

      const absTop =
        el.getBoundingClientRect().top -
        sc.getBoundingClientRect().top +
        sc.scrollTop;

      result.push({
        ...h,
        pct: Math.min(98, Math.max(1, (absTop / scrollHeight) * 100)),
        cssVar: getCategoryVar(h.category),
      });
    }

    setMarkers(result);
  }, [scrollContainerRef, headings]);

  useEffect(() => {
    const sc = scrollContainerRef.current;
    if (!sc) return;
    recalc();
    const observer = new ResizeObserver(recalc);
    observer.observe(sc);
    return () => observer.disconnect();
  }, [scrollContainerRef, recalc]);

  const scrollTo = useCallback(
    (anchorId: string) => {
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
    },
    [scrollContainerRef],
  );

  if (markers.length === 0) return null;

  return (
    <div
      className={cn(
        "absolute top-0 right-0 bottom-0 z-20 max-lg:hidden",
        active ? "w-36 transition-[width] duration-150" : "w-5 transition-[width] duration-150",
      )}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      onWheel={(e) => {
        scrollContainerRef.current?.scrollBy(0, e.deltaY);
      }}
    >
      {markers.map((m) => (
        <button
          className="absolute right-0 flex items-center gap-0.5 hover:opacity-100"
          key={m.id}
          onClick={() => scrollTo(m.startAnchorId)}
          style={{ top: `${m.pct}%`, transform: "translateY(-50%)" }}
          type="button"
        >
          {/* Pill label */}
          <span
            className={cn(
              "max-w-32 truncate rounded-full px-2.5 py-1 text-[0.65rem] font-semibold leading-none shadow-sm",
              active
                ? "opacity-90 transition-opacity duration-100"
                : "pointer-events-none opacity-0 transition-opacity duration-300",
            )}
            style={{
              backgroundColor: `color-mix(in srgb, var(${m.cssVar}) 20%, var(--color-background))`,
              color: `var(${m.cssVar})`,
            }}
          >
            {m.label}
          </span>
          {/* Tick */}
          <div
            className="shrink-0 rounded-full transition-all duration-150"
            style={{
              backgroundColor: `var(${m.cssVar})`,
              width: active ? "12px" : "5px",
              height: active ? "5px" : "3px",
              opacity: active ? 0.8 : 0.35,
            }}
          />
        </button>
      ))}
    </div>
  );
};
