/**
 * Scrollbar heading markers.
 *
 * Single container on the right edge. Dots always visible.
 * Hover anywhere in the zone expands ticks and shows labels.
 * Click scrolls to heading. Wheel events pass through
 * naturally (no overflow on this element).
 */

import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";

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
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const recalc = useCallback(() => {
    const sc = scrollContainerRef.current;
    if (!sc || headings.length === 0) {
      return;
    }

    const scrollHeight = sc.scrollHeight;
    if (scrollHeight <= 0) {
      return;
    }

    const result: Positioned[] = [];

    for (const h of headings) {
      const el = sc.querySelector(`#${CSS.escape(h.startAnchorId)}`);
      if (!el) {
        continue;
      }

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
    if (!sc) {
      return undefined;
    }
    recalc();
    const observer = new ResizeObserver(recalc);
    observer.observe(sc);
    return () => observer.disconnect();
  }, [scrollContainerRef, recalc]);

  const scrollTo = useCallback(
    (anchorId: string) => {
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
      delete el.dataset.highlight;
      void el.offsetWidth;
      el.dataset.highlight = "";
    },
    [scrollContainerRef],
  );

  if (markers.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "absolute top-0 right-0 bottom-0 z-20 max-lg:hidden",
        active
          ? "w-36 transition-[width] duration-150"
          : "w-5 transition-[width] duration-150",
      )}
      onMouseEnter={(e) => {
        // Skip expansion while the user is dragging to select
        // text. `buttons` is a bitmask of pressed mouse buttons;
        // anything non-zero means a drag is in progress.
        if (e.buttons === 0) {
          setActive(true);
        }
      }}
      onMouseLeave={() => setActive(false)}
      onWheel={(e) => {
        scrollContainerRef.current?.scrollBy(0, e.deltaY);
      }}
    >
      {markers.map((m) => {
        const isHovered = hoveredId === m.id;
        return (
          <button
            className="absolute right-0 flex items-center gap-0.5"
            key={m.id}
            onClick={() => scrollTo(m.startAnchorId)}
            onMouseEnter={() => setHoveredId(m.id)}
            onMouseLeave={() => setHoveredId(null)}
            style={{ top: `${m.pct}%`, transform: "translateY(-50%)" }}
            type="button"
          >
            {/* Pill label — the marker under the cursor gets more
                room and contrast so its full label reads clearly,
                while its siblings stay compact and unobtrusive. */}
            <span
              className={cn(
                "truncate rounded-full px-2.5 py-1 text-[0.65rem] leading-none font-semibold shadow-sm transition-[max-width,opacity,font-size] duration-150",
                isHovered ? "max-w-72 text-[0.7rem] opacity-100" : "max-w-52",
                active
                  ? isHovered
                    ? ""
                    : "opacity-70"
                  : "pointer-events-none opacity-0 transition-opacity duration-300",
              )}
              style={{
                backgroundColor: isHovered
                  ? `color-mix(in srgb, var(${m.cssVar}) 36%, var(--color-background))`
                  : `color-mix(in srgb, var(${m.cssVar}) 20%, var(--color-background))`,
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
                width: isHovered ? "16px" : active ? "12px" : "8px",
                height: isHovered ? "6px" : active ? "5px" : "4px",
                opacity: isHovered ? 1 : active ? 0.9 : 0.8,
              }}
            />
          </button>
        );
      })}
    </div>
  );
};
