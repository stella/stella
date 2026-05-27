/**
 * Scrollbar markers — minimap rail on the right edge of a scroll container.
 *
 * Single column of ticks; hover anywhere on the rail expands them and reveals
 * full label pills. Click jumps to the marker's anchor element inside the
 * scroll container.
 *
 * Generic over the marker type so the same component can drive a case-law
 * analysis sidebar (anchors keyed by HTML id) or a docx outline (anchors keyed
 * by ProseMirror position). Callers provide a `resolveAnchor` resolver and an
 * optional `onMarkerClick` override.
 */

"use client";

import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useState,
} from "react";

import { cn } from "@stll/ui/lib/utils";

export type ScrollMarker = {
  id: string;
  label: string;
  /** CSS custom-property name driving the tick + pill color (e.g. `--option-blue`). */
  cssVar: string;
  /** Tick width in px when collapsed. Optional; defaults to 8. */
  tickWidth?: number;
};

export type ScrollMarkersProps<M extends ScrollMarker = ScrollMarker> = {
  markers: M[];
  scrollContainerRef: RefObject<HTMLElement | null>;
  /**
   * Return the marker's top offset in pixels inside the scroll container
   * (i.e. distance from `container.scrollTop = 0`). Return `null` to drop the
   * marker from the rail.
   *
   * Callers handling virtualised content can return an estimated position
   * when the exact DOM node isn't mounted, so the rail stays complete.
   */
  resolveTop: (marker: M, container: HTMLElement) => number | null;
  /** Click handler. The caller is responsible for scrolling. */
  onMarkerClick: (marker: M, container: HTMLElement) => void;
  /** Top offset in px (skip e.g. a sticky toolbar). */
  topOffset?: number;
  /** Tailwind class applied when the rail is expanded. Defaults to `w-36`. */
  expandedClassName?: string;
  className?: string;
};

type Positioned<M extends ScrollMarker> = M & { pct: number };

export const ScrollMarkers = <M extends ScrollMarker>({
  markers,
  scrollContainerRef,
  resolveTop,
  onMarkerClick,
  topOffset = 0,
  expandedClassName = "w-36",
  className,
}: ScrollMarkersProps<M>) => {
  const [positioned, setPositioned] = useState<Positioned<M>[]>([]);
  const [active, setActive] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const recalc = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || markers.length === 0) {
      setPositioned([]);
      return;
    }

    const scrollHeight = container.scrollHeight;
    if (scrollHeight <= 0) {
      return;
    }

    const next: Positioned<M>[] = [];
    for (const marker of markers) {
      const top = resolveTop(marker, container);
      if (top === null) {
        continue;
      }
      const pct = Math.min(98, Math.max(1, (top / scrollHeight) * 100));
      next.push({ ...marker, pct });
    }
    setPositioned(next);
  }, [scrollContainerRef, markers, resolveTop]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return undefined;
    }
    recalc();
    const observer = new ResizeObserver(recalc);
    observer.observe(container);
    return () => observer.disconnect();
  }, [scrollContainerRef, recalc]);

  if (positioned.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "absolute end-0 z-20 max-lg:hidden",
        active
          ? `${expandedClassName} transition-[width] duration-150`
          : "w-5 transition-[width] duration-150",
        className,
      )}
      style={{ top: topOffset, bottom: 0 }}
      onMouseEnter={(event) => {
        // Skip expansion while the user is dragging to select text.
        if (event.buttons === 0) {
          setActive(true);
        }
      }}
      onMouseLeave={() => {
        setActive(false);
        setHoveredId(null);
      }}
      onWheel={(event) => {
        scrollContainerRef.current?.scrollBy(0, event.deltaY);
      }}
    >
      {positioned.map((marker) => {
        const isHovered = hoveredId === marker.id;
        const collapsedTickWidth = marker.tickWidth ?? 8;
        const tickStyle: CSSProperties = (() => {
          if (isHovered) {
            return {
              backgroundColor: `var(${marker.cssVar})`,
              height: "6px",
              opacity: 1,
              width: "16px",
            };
          }
          if (active) {
            return {
              backgroundColor: `var(${marker.cssVar})`,
              height: "5px",
              opacity: 0.9,
              width: `${Math.max(12, collapsedTickWidth + 4)}px`,
            };
          }
          return {
            backgroundColor: `var(${marker.cssVar})`,
            height: "4px",
            opacity: 0.8,
            width: `${collapsedTickWidth}px`,
          };
        })();

        return (
          <button
            key={marker.id}
            type="button"
            className="absolute end-0 flex items-center gap-0.5"
            style={{ top: `${marker.pct}%`, transform: "translateY(-50%)" }}
            onClick={() => {
              const container = scrollContainerRef.current;
              if (!container) {
                return;
              }
              onMarkerClick(marker, container);
            }}
            onMouseEnter={() => setHoveredId(marker.id)}
            onMouseLeave={() => setHoveredId(null)}
            title={marker.label}
          >
            <span
              className={cn(
                "truncate rounded-full px-2.5 py-1 text-[0.65rem] leading-none font-semibold shadow-sm transition-[max-width,opacity,font-size] duration-150",
                isHovered ? "max-w-72 text-[0.7rem] opacity-100" : "max-w-52",
                (() => {
                  if (active) {
                    if (isHovered) {
                      return "";
                    }
                    return "opacity-70";
                  }
                  return "pointer-events-none opacity-0 transition-opacity duration-300";
                })(),
              )}
              style={{
                backgroundColor: isHovered
                  ? `color-mix(in srgb, var(${marker.cssVar}) 36%, var(--color-background))`
                  : `color-mix(in srgb, var(${marker.cssVar}) 20%, var(--color-background))`,
                color: `var(${marker.cssVar})`,
              }}
            >
              {marker.label}
            </span>
            <div
              className="shrink-0 rounded-full transition-[width,height,opacity,background-color] duration-150"
              style={tickStyle}
            />
          </button>
        );
      })}
    </div>
  );
};
