/**
 * Document outline rail for the docx editor.
 *
 * Always-visible thin column of ticks on the right edge: one tick per heading,
 * width tapering by heading level, vertical position derived from the
 * heading's PM position relative to the full document size (the paged editor
 * virtualises pages, so we can't rely on DOM measurement for off-screen
 * paragraphs).
 *
 * Hovering the rail reveals a single popover panel listing every heading in
 * its natural hierarchy. The currently-in-view heading is emphasised but
 * never with a saturated accent.
 */

import type React from "react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { findBodyPmAnchors } from "../core/layout-bridge/findBodyPmSpans";
import type { HeadingInfo } from "../core/utils/headingCollector";
import { cn } from "../lib/utils";

const TICK_BASE_WIDTH = 6;
const TICK_LEVEL_STEP = 2;
const TICK_MAX_LEVEL = 6;
const RAIL_WIDTH = 20;
const PANEL_WIDTH = 320;
const PANEL_GAP = 6;
// When the rail would otherwise host more ticks than this, deeper levels are
// pruned until the visible count fits. Keeps the rail readable at a glance;
// the popover panel still lists every heading.
const RAIL_MAX_TICKS = 30;

export type DocumentOutlineProps = {
  headings: HeadingInfo[];
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  topOffset: number;
  /** Total ProseMirror document content size — drives proportional tick
   *  placement when pages are virtualised. */
  docSize: number;
  onHeadingClick: (pmPos: number) => void;
};

type Positioned = HeadingInfo & {
  index: number;
  pct: number;
  tickWidth: number;
};

const tickWidthFor = (level: number): number => {
  const clamped = Math.min(Math.max(level, 0), TICK_MAX_LEVEL);
  return TICK_BASE_WIDTH + (TICK_MAX_LEVEL - clamped) * TICK_LEVEL_STEP;
};

export const DocumentOutline: React.FC<DocumentOutlineProps> = ({
  headings,
  scrollContainerRef,
  topOffset,
  docSize,
  onHeadingClick,
}) => {
  const [hovered, setHovered] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Suppress the scroll-driven active detector for a short window after the
  // user clicks a rail/panel entry. Without this, the in-flight smooth-scroll
  // re-fires onScroll many times before the target lands at viewport centre,
  // and the detector reverts to the previous heading.
  const manualLockUntilRef = useRef(0);

  const positioned = useMemo<Positioned[]>(() => {
    if (docSize <= 0) {
      return [];
    }
    // Pick the deepest heading level we can show on the rail without
    // exceeding RAIL_MAX_TICKS. Count once per level then walk down.
    const countsByLevel: number[] = Array.from(
      { length: TICK_MAX_LEVEL + 1 },
      () => 0,
    );
    for (const heading of headings) {
      const clamped = Math.min(Math.max(heading.level, 0), TICK_MAX_LEVEL);
      countsByLevel[clamped]! += 1;
    }
    let maxLevel = TICK_MAX_LEVEL;
    let runningCount = headings.length;
    while (maxLevel > 0 && runningCount > RAIL_MAX_TICKS) {
      runningCount -= countsByLevel[maxLevel]!;
      maxLevel--;
    }
    return headings
      .map((heading, index) => ({
        ...heading,
        index,
        pct: Math.min(99, Math.max(1, (heading.pmPos / docSize) * 100)),
        tickWidth: tickWidthFor(heading.level),
      }))
      .filter((p) => p.level <= maxLevel);
  }, [headings, docSize]);

  // Track which heading is currently in view by walking the rendered anchors
  // (only those in the virtualised buffer have real DOM positions to compare).
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || headings.length === 0) {
      return;
    }

    const compute = () => {
      if (Date.now() < manualLockUntilRef.current) {
        return;
      }
      const anchors = findBodyPmAnchors(container);
      if (anchors.length === 0) {
        return;
      }
      const containerTop = container.getBoundingClientRect().top;
      // Threshold sits at the visual centre of the viewport so the active
      // heading matches what the eye reads as "current section". Anchoring it
      // at the top picks the heading on the previous page once the user
      // jumps to a new section via the rail.
      const threshold =
        container.scrollTop + topOffset + container.clientHeight / 2;
      const offsets: { pm: number; top: number }[] = [];
      for (const el of anchors) {
        const pm = Number(el.dataset["pmStart"]);
        if (!Number.isFinite(pm)) {
          continue;
        }
        offsets.push({
          pm,
          top:
            el.getBoundingClientRect().top - containerTop + container.scrollTop,
        });
      }
      offsets.sort((a, b) => a.pm - b.pm);

      let next = 0;
      for (let i = 0; i < headings.length; i++) {
        const target = headings[i]!.pmPos;
        let candidate: { pm: number; top: number } | undefined;
        for (const offset of offsets) {
          if (offset.pm >= target) {
            candidate = offset;
            break;
          }
        }
        if (!candidate) {
          continue;
        }
        if (candidate.top <= threshold) {
          next = i;
        }
      }
      setActiveIndex(next);
    };

    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(compute);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    raf = requestAnimationFrame(compute);
    return () => {
      cancelAnimationFrame(raf);
      container.removeEventListener("scroll", onScroll);
    };
  }, [scrollContainerRef, headings, topOffset]);

  const jumpToHeading = useCallback(
    (pmPos: number, index: number) => {
      // Optimistic: light up the clicked entry immediately so the user gets
      // feedback before the scroll settles. The scroll listener is locked out
      // for a short window so it doesn't overwrite us mid-scroll; it then
      // takes over once the user manually scrolls again.
      setActiveIndex(index);
      manualLockUntilRef.current = Date.now() + 900;
      onHeadingClick(pmPos);
    },
    [onHeadingClick],
  );

  const openPanel = useCallback(() => {
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
    setHovered(true);
  }, []);

  const schedulePanelClose = useCallback(() => {
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
    }
    hoverCloseTimerRef.current = setTimeout(() => {
      setHovered(false);
    }, 120);
  }, []);

  useEffect(
    () => () => {
      if (hoverCloseTimerRef.current) {
        clearTimeout(hoverCloseTimerRef.current);
      }
    },
    [],
  );

  if (positioned.length < 2) {
    return null;
  }

  return (
    <div
      aria-label="Document outline"
      className="absolute end-0 z-20 max-lg:hidden"
      style={{ top: topOffset, bottom: 0, width: RAIL_WIDTH }}
    >
      {/* Rail — always visible. Captures hover for the panel. */}
      <div
        className="relative h-full"
        onMouseEnter={openPanel}
        onMouseLeave={schedulePanelClose}
        onWheel={(event) => {
          scrollContainerRef.current?.scrollBy(0, event.deltaY);
        }}
      >
        {positioned.map((marker) => {
          const isActive = activeIndex === marker.index;
          return (
            <button
              key={`${marker.pmPos}-${marker.index}`}
              type="button"
              onClick={() => jumpToHeading(marker.pmPos, marker.index)}
              title={marker.text}
              aria-label={marker.text}
              aria-current={isActive ? "true" : undefined}
              className={cn(
                "absolute end-0 rounded-full transition-[width,height,opacity,background-color] duration-150",
                isActive ? "opacity-95" : "opacity-50 hover:opacity-95",
              )}
              style={{
                top: `${marker.pct}%`,
                transform: "translateY(-50%)",
                width: marker.tickWidth,
                height: isActive ? 3 : 2,
                background: "var(--color-foreground)",
              }}
            />
          );
        })}
      </div>

      {/* Hover panel — clean indented list. */}
      <div
        role="navigation"
        onMouseEnter={openPanel}
        onMouseLeave={schedulePanelClose}
        className={cn(
          "border-border bg-popover text-popover-foreground absolute overflow-y-auto rounded-xl border shadow-lg",
          "transition-[opacity,transform] duration-150",
          hovered
            ? "translate-x-0 opacity-100"
            : "pointer-events-none translate-x-2 opacity-0",
        )}
        style={{
          top: 0,
          insetInlineEnd: RAIL_WIDTH + PANEL_GAP,
          width: PANEL_WIDTH,
          maxHeight: "calc(100% - 24px)",
          padding: "10px 6px",
        }}
        aria-hidden={!hovered}
      >
        <ul className="m-0 list-none p-0">
          {headings.map((heading, index) => {
            const isActive = activeIndex === index;
            const clampedLevel = Math.min(heading.level, TICK_MAX_LEVEL);
            return (
              <li key={`${heading.pmPos}-${index}-li`}>
                <button
                  type="button"
                  onClick={() => jumpToHeading(heading.pmPos, index)}
                  title={heading.text}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md py-1 text-start text-[13px] leading-snug",
                    "hover:bg-accent transition-colors",
                    isActive
                      ? "text-foreground font-medium"
                      : "text-muted-foreground",
                  )}
                  style={{
                    paddingInlineStart: 10 + clampedLevel * 12,
                    paddingInlineEnd: 10,
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {heading.text}
                  </span>
                  {typeof heading.pageNumber === "number" && (
                    <span className="text-foreground-placeholder shrink-0 text-[11px] tabular-nums">
                      {heading.pageNumber}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
};
