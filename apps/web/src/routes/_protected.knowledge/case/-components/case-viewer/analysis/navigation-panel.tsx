/**
 * Navigation panel showing the heading + annotation tree.
 *
 * Sticks to the top of the viewport and highlights the heading
 * whose anchor is currently scrolled into view. Annotations are
 * nested under their parent heading.
 */

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { ChevronRightIcon, SparklesIcon } from "lucide-react";

import { cn } from "@stella/ui/lib/utils";

import type { AnalysisHeading } from "./types";

type NavigationPanelProps = {
  tree: AnalysisHeading[];
  scrollContainerRef: RefObject<HTMLElement | null>;
};

/** Flatten headings for scroll tracking. */
const flattenHeadings = (headings: AnalysisHeading[]): AnalysisHeading[] => {
  const result: AnalysisHeading[] = [];
  for (const h of headings) {
    result.push(h);
    result.push(...flattenHeadings(h.children));
  }
  return result;
};

const scrollToAnchor = (anchorId: string, container: HTMLElement | null) => {
  if (!container) {
    return;
  }
  const el = container.querySelector<HTMLElement>(`#${CSS.escape(anchorId)}`);
  if (!el) {
    return;
  }
  const offset =
    el.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop;
  container.scrollTo({ top: offset, behavior: "instant" });

  // Trigger CSS highlight animation
  delete el.dataset.highlight;
  // Force reflow so removing and re-adding triggers the animation
  void el.offsetWidth;
  el.dataset.highlight = "";
};

const HeadingNode = ({
  heading,
  depth,
  activeId,
  scrollContainerRef,
}: {
  heading: AnalysisHeading;
  depth: number;
  activeId: string | null;
  scrollContainerRef: RefObject<HTMLElement | null>;
}) => {
  const [expanded, setExpanded] = useState(true);
  const isActive = heading.id === activeId;
  const hasChildren =
    heading.annotations.length > 0 || heading.children.length > 0;

  return (
    <div>
      <button
        className={cn(
          "group flex w-full items-start gap-1.5 rounded px-2 py-1.5 text-start text-xs transition-colors",
          isActive
            ? "bg-muted text-foreground"
            : "hover:bg-muted/60 text-muted-foreground",
        )}
        data-heading-id={heading.id}
        onClick={() => {
          if (hasChildren) {
            setExpanded(!expanded);
          }
          scrollToAnchor(heading.startAnchorId, scrollContainerRef.current);
        }}
        style={{ paddingInlineStart: `${depth * 12 + 8}px` }}
        type="button"
      >
        {hasChildren && (
          <ChevronRightIcon
            className={cn(
              "mt-0.5 size-3 shrink-0 transition-transform",
              expanded && "rotate-90",
            )}
          />
        )}
        <span className="leading-tight font-medium">{heading.label}</span>
      </button>

      {expanded && (
        <div>
          {heading.annotations.map((annotation) => (
            <button
              className="hover:bg-muted/40 text-muted-foreground w-full rounded px-2 py-1 text-start text-[0.7rem] leading-relaxed"
              key={annotation.id}
              onClick={() =>
                scrollToAnchor(
                  annotation.startAnchorId,
                  scrollContainerRef.current,
                )
              }
              style={{
                paddingInlineStart: `${(depth + 1) * 12 + 8}px`,
              }}
              type="button"
            >
              {annotation.summary}
            </button>
          ))}
          {heading.children.map((child) => (
            <HeadingNode
              activeId={activeId}
              depth={depth + 1}
              heading={child}
              key={child.id}
              scrollContainerRef={scrollContainerRef}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const NavigationPanel = ({
  tree,
  scrollContainerRef,
}: NavigationPanelProps) => {
  const [activeId, setActiveId] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);

  const flat = flattenHeadings(tree);

  // Track which heading is in view based on scroll position
  useEffect(() => {
    const sc = scrollContainerRef.current;
    if (!sc || flat.length === 0) {
      return undefined;
    }

    const handleScroll = () => {
      const container = scrollContainerRef.current;
      if (!container) {
        return;
      }
      let active: AnalysisHeading | null = null;
      const threshold = container.clientHeight / 3;

      for (const heading of flat) {
        const el = container.querySelector(
          `#${CSS.escape(heading.startAnchorId)}`,
        );
        if (!el) {
          continue;
        }
        const top =
          el.getBoundingClientRect().top -
          container.getBoundingClientRect().top;
        if (top <= threshold) {
          active = heading;
        }
      }

      const newId = active?.id ?? null;
      setActiveId(newId);

      // Auto-scroll the nav panel to keep active heading visible
      if (newId && navRef.current) {
        const activeEl = navRef.current.querySelector(
          `[data-heading-id="${CSS.escape(newId)}"]`,
        );
        activeEl?.scrollIntoView({ block: "nearest", behavior: "instant" });
      }
    };

    handleScroll();
    sc.addEventListener("scroll", handleScroll, { passive: true });
    return () => sc.removeEventListener("scroll", handleScroll);
  }, [scrollContainerRef, flat]);

  if (tree.length === 0) {
    return null;
  }

  return (
    <nav className="flex flex-col gap-0.5" ref={navRef}>
      <div className="text-muted-foreground mb-1 flex items-center gap-1.5 px-2 text-[0.65rem] font-semibold tracking-wider uppercase">
        <SparklesIcon className="size-3" />
        AI Analysis
      </div>
      {tree.map((heading) => (
        <HeadingNode
          activeId={activeId}
          depth={0}
          heading={heading}
          key={heading.id}
          scrollContainerRef={scrollContainerRef}
        />
      ))}
    </nav>
  );
};
