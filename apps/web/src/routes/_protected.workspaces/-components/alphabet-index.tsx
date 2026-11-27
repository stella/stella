/**
 * Scroll markers for client groups.
 *
 * Mirrors the case-law ScrollMarkers UX: compact dots on the right
 * edge, expand to show client name labels on hover, click to scroll.
 * Positions are calculated from actual DOM positions of group headers.
 */

import { useState } from "react";
import type { RefObject } from "react";

import { Button } from "@stll/ui/button";
import { useObservedValue } from "@stll/ui/effects-dom";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import type { WorkspaceGroup } from "@/lib/workspaces/types";

type AlphabetIndexProps = {
  groups: WorkspaceGroup[];
  collapsedGroups: string[];
  scrollContainerRef: RefObject<HTMLElement | null>;
};

type Marker = {
  groupId: string;
  label: string;
  pct: number;
};

/** Each indexed group's position, in % of the scroll height, by group id. */
type GroupPositions = Readonly<Record<string, number>>;

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

const groupLetter = (group: WorkspaceGroup): string =>
  group.type === "personal"
    ? "★"
    : (group.clientName.at(0)?.toUpperCase() ?? "#");

const findGroupHeader = (container: HTMLElement, groupId: string) =>
  container.querySelector<HTMLElement>(
    `[data-group-id="${CSS.escape(groupId)}"]`,
  );

/**
 * Where the first group of each letter starts, or null while the container
 * has no height to place them in.
 */
const measureGroupPositions = (
  container: HTMLElement,
  groups: readonly WorkspaceGroup[],
): GroupPositions | null => {
  const scrollHeight = container.scrollHeight;
  if (scrollHeight <= 0) {
    return null;
  }
  const positions: [string, number][] = [];
  const seenLetters = new Set<string>();
  for (const group of groups) {
    const letter = groupLetter(group);
    if (seenLetters.has(letter)) {
      continue;
    }
    seenLetters.add(letter);
    const header = findGroupHeader(container, group.groupId);
    if (!header) {
      continue;
    }
    const top = getOffsetTop(header, container);
    positions.push([
      group.groupId,
      Math.min(98, Math.max(1, (top / scrollHeight) * 100)),
    ]);
  }
  return Object.fromEntries(positions);
};

export const AlphabetIndex = ({
  groups,
  collapsedGroups,
  scrollContainerRef,
}: AlphabetIndexProps) => {
  const [active, setActive] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // The index's own element, rendered (hidden) even while there are too few
  // groups to index, so the measurement below always has an owner to run on.
  const [indexElement, setIndexElement] = useState<HTMLDivElement | null>(null);

  // Measured before the first paint and again when the scroll container
  // resizes or groups collapse or expand (the content reflows).
  const positions = useObservedValue<HTMLDivElement, GroupPositions | null>(
    indexElement,
    (_index, emit) => {
      const container = scrollContainerRef.current;
      if (!container) {
        return () => undefined;
      }
      const measure = () => {
        const measured = measureGroupPositions(container, groups);
        if (measured !== null) {
          emit(measured);
        }
      };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(container);
      return () => observer.disconnect();
    },
    [groups, collapsedGroups, scrollContainerRef],
    null,
  );

  const markers: Marker[] = groups.flatMap((group) => {
    const pct =
      positions !== null && Object.hasOwn(positions, group.groupId)
        ? positions[group.groupId]
        : undefined;
    return pct === undefined
      ? []
      : [{ groupId: group.groupId, label: groupLetter(group), pct }];
  });

  const scrollTo = (groupId: string) => {
    const sc = scrollContainerRef.current;
    if (!sc) {
      return;
    }
    const target = findGroupHeader(sc, groupId);
    if (!target) {
      return;
    }
    sc.scrollTo({ top: getOffsetTop(target, sc), behavior: "instant" });

    // Flash ring on the target group header
    target.classList.add("ring-2", "ring-primary");
    setTimeout(() => {
      target.classList.remove("ring-2", "ring-primary");
    }, 600);
  };

  const shown = markers.length >= MIN_GROUPS_FOR_INDEX;

  return (
    <div
      hidden={!shown}
      ref={setIndexElement}
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
      {shown &&
        markers.map((m) => {
          const isHovered = hoveredId === m.groupId;
          return (
            <Button
              className="absolute end-0 flex items-center"
              key={m.groupId}
              onClick={() => scrollTo(m.groupId)}
              onMouseEnter={() => setHoveredId(m.groupId)}
              onMouseLeave={() => setHoveredId(null)}
              shape="round"
              style={{ top: `${m.pct}%`, transform: "translateY(-50%)" }}
              variant="plain"
            >
              <TruncatedText
                className={cn(
                  "text-3xs rounded-full px-2.5 py-1 leading-none font-semibold shadow-sm transition-[max-width,opacity,font-size] duration-150",
                  isHovered ? "text-2xs max-w-72 opacity-100" : "max-w-52",
                  (() => {
                    if (active) {
                      return (() => {
                        if (isHovered) {
                          return "";
                        }
                        return "opacity-70";
                      })();
                    }
                    return "pointer-events-none opacity-0 transition-opacity duration-300";
                  })(),
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
              </TruncatedText>
              <div
                className="shrink-0 rounded-full transition-[width,height,opacity] duration-150"
                style={{
                  backgroundColor: isHovered
                    ? "var(--color-primary)"
                    : "var(--color-muted-foreground)",
                  width: (() => {
                    if (isHovered) {
                      return "16px";
                    }
                    if (active) {
                      return "12px";
                    }
                    return "8px";
                  })(),
                  height: (() => {
                    if (isHovered) {
                      return "6px";
                    }
                    if (active) {
                      return "5px";
                    }
                    return "4px";
                  })(),
                  opacity: (() => {
                    if (isHovered) {
                      return 1;
                    }
                    if (active) {
                      return 0.9;
                    }
                    return 0.5;
                  })(),
                }}
              />
            </Button>
          );
        })}
    </div>
  );
};
