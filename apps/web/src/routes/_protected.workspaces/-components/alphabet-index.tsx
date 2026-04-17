/**
 * Scroll markers for client groups.
 *
 * Mirrors the case-law ScrollMarkers UX: compact dots on the right
 * edge, expand to show client name labels on hover, click to scroll.
 * Positions are calculated from actual DOM positions of group headers.
 */

import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";

import { cn } from "@stella/ui/lib/utils";

import type { WorkspaceGroup } from "@/routes/_protected.workspaces/-types";

type AlphabetIndexProps = {
  groups: WorkspaceGroup[];
  collapsedGroups: string[];
  scrollContainerRef: RefObject<HTMLElement | null>;
};

type Positioned = {
  groupId: string;
  label: string;
  pct: number;
  top: number;
};

const MIN_GROUPS_FOR_INDEX = 6;

/** Walk offsetParent chain to get true top offset unaffected by sticky. */
const getOffsetTop = (el: HTMLElement, container: HTMLElement): number => {
  let offset = 0;
  let node: Element | null = el;
  while (node instanceof HTMLElement && node !== container) {
    offset += node.offsetTop;
    node = node.offsetParent;
  }
  return offset;
};

export const AlphabetIndex = ({
  groups,
  collapsedGroups,
  scrollContainerRef,
}: AlphabetIndexProps) => {
  const [markers, setMarkers] = useState<Positioned[]>([]);
  const [active, setActive] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const recalc = useCallback(() => {
    const sc = scrollContainerRef.current;
    if (!sc || groups.length === 0) {
      return;
    }

    const scrollHeight = sc.scrollHeight;
    if (scrollHeight <= 0) {
      return;
    }

    const result: Positioned[] = [];
    const seenLetters = new Set<string>();

    for (const g of groups) {
      const letter = g.clientName.at(0)?.toUpperCase() ?? "#";

      if (seenLetters.has(letter)) {
        continue;
      }
      seenLetters.add(letter);

      const el = sc.querySelector<HTMLElement>(
        `[data-group-id="${CSS.escape(g.groupId)}"]`,
      );
      if (!(el instanceof HTMLElement)) {
        continue;
      }

      const absTop = getOffsetTop(el, sc);

      result.push({
        groupId: g.groupId,
        label: letter,
        pct: Math.min(98, Math.max(1, (absTop / scrollHeight) * 100)),
        top: absTop,
      });
    }

    setMarkers(result);
  }, [scrollContainerRef, groups]);

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

  // Recalculate when groups collapse/expand (content reflows)
  useEffect(() => {
    recalc();
  }, [collapsedGroups, recalc]);

  const scrollTo = useCallback(
    (groupId: string) => {
      const sc = scrollContainerRef.current;
      if (!sc) {
        return;
      }
      const marker = markers.find((m) => m.groupId === groupId);
      if (!marker) {
        return;
      }
      sc.scrollTo({ top: marker.top, behavior: "instant" });
    },
    [scrollContainerRef, markers],
  );

  if (markers.length < MIN_GROUPS_FOR_INDEX) {
    return null;
  }

  return (
    <div
      className={cn(
        "absolute end-0 top-0 bottom-0 z-20 max-lg:hidden",
        active
          ? "w-36 transition-[width] duration-150"
          : "w-5 transition-[width] duration-150",
      )}
      onMouseEnter={(e) => {
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
        const isHovered = hoveredId === m.groupId;
        return (
          <button
            className="absolute end-0 flex items-center gap-0.5"
            key={m.groupId}
            onClick={() => scrollTo(m.groupId)}
            onMouseEnter={() => setHoveredId(m.groupId)}
            onMouseLeave={() => setHoveredId(null)}
            style={{ top: `${m.pct}%`, transform: "translateY(-50%)" }}
            type="button"
          >
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
                  ? "color-mix(in srgb, var(--color-primary) 20%, var(--color-background))"
                  : "color-mix(in srgb, var(--color-muted-foreground) 15%, var(--color-background))",
                color: isHovered
                  ? "var(--color-primary)"
                  : "var(--color-muted-foreground)",
              }}
            >
              {m.label}
            </span>
            <div
              className="shrink-0 rounded-full transition-all duration-150"
              style={{
                backgroundColor: isHovered
                  ? "var(--color-primary)"
                  : "var(--color-muted-foreground)",
                width: isHovered ? "16px" : active ? "12px" : "8px",
                height: isHovered ? "6px" : active ? "5px" : "4px",
                opacity: isHovered ? 1 : active ? 0.9 : 0.5,
              }}
            />
          </button>
        );
      })}
    </div>
  );
};
