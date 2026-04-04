/**
 * Scroll-aware heading indicator in the bottom bar.
 *
 * Shows the current heading based on scroll position. Click to
 * open a dropdown listing all headings; click to scroll.
 */

import { type RefObject, useEffect, useRef, useState } from "react";

import { ChevronDownIcon, SparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

import {
  type AnalysisHeading,
  formatCategoryLabel,
  getCategoryVar,
} from "./types";

type HeadingBreadcrumbProps = {
  tree: AnalysisHeading[];
  scrollContainerRef: RefObject<HTMLElement | null>;
};

const flattenHeadings = (
  headings: AnalysisHeading[],
  depth = 0,
): (AnalysisHeading & { depth: number })[] => {
  const result: (AnalysisHeading & { depth: number })[] = [];
  for (const h of headings) {
    result.push({ ...h, depth });
    result.push(...flattenHeadings(h.children, depth + 1));
  }
  return result;
};

export const HeadingBreadcrumb = ({
  tree,
  scrollContainerRef,
}: HeadingBreadcrumbProps) => {
  const t = useTranslations();
  const categoryLabel = (cat: string) =>
    t.has(`caseLaw.analysis.categories.${cat}` as never)
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      ? (t(`caseLaw.analysis.categories.${cat}` as never) as string)
      : formatCategoryLabel(cat);
  const [currentHeading, setCurrentHeading] = useState<AnalysisHeading | null>(
    null,
  );
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const flatHeadings = flattenHeadings(tree);

  useEffect(() => {
    const sc = scrollContainerRef.current;
    if (!sc || flatHeadings.length === 0) return;

    const handleScroll = () => {
      const container = scrollContainerRef.current;
      if (!container) return;
      let active: AnalysisHeading | null = null;

      for (const heading of flatHeadings) {
        const el = container.querySelector(
          `#${CSS.escape(heading.startAnchorId)}`,
        );
        if (!el) continue;
        const top =
          el.getBoundingClientRect().top -
          container.getBoundingClientRect().top;
        if (top <= container.clientHeight / 3) {
          active = heading;
        }
      }

      setCurrentHeading(active);
    };

    handleScroll();
    sc.addEventListener("scroll", handleScroll, { passive: true });
    return () => sc.removeEventListener("scroll", handleScroll);
  }, [scrollContainerRef, flatHeadings]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClick = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const id = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [isOpen]);

  const scrollToHeading = (heading: AnalysisHeading) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const el = container.querySelector(
      `#${CSS.escape(heading.startAnchorId)}`,
    );
    if (!el) return;
    const offset =
      el.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop;
    container.scrollTo({ top: offset, behavior: "instant" });
    setIsOpen(false);
  };

  if (flatHeadings.length === 0) return null;

  return (
    <div className="relative w-full" ref={wrapperRef}>
      <button
        className={cn(
          "flex w-full items-center gap-2 overflow-hidden rounded-full px-3 py-1.5 text-sm",
          "hover:bg-muted/50 text-foreground",
        )}
        onClick={() => setIsOpen((o) => !o)}
        type="button"
      >
        {currentHeading ? (
          <>
            <span
              className="shrink-0 rounded px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider text-white"
              style={{ backgroundColor: `var(${getCategoryVar(currentHeading.category)})` }}
            >
              {categoryLabel(currentHeading.category)}
            </span>
            <span className="truncate font-medium">
              {currentHeading.label}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground text-xs">Sections</span>
        )}
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            isOpen && "rotate-180",
          )}
        />
      </button>

      {isOpen && (
        <div className="bg-popover border-border absolute bottom-full left-1/2 z-50 mb-1 w-80 -translate-x-1/2 overflow-hidden rounded-lg border shadow-lg">
          <div className="max-h-[400px] overflow-y-auto p-1">
            <div className="text-muted-foreground flex items-center gap-1.5 px-3 py-1.5 text-[0.6rem] font-semibold uppercase tracking-wider">
              <SparklesIcon className="size-3" />
              AI Analysis
            </div>
            {flatHeadings.map((heading) => (
              <button
                className={cn(
                  "hover:bg-muted flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm",
                  currentHeading?.id === heading.id && "bg-muted",
                )}
                key={heading.id}
                onClick={() => scrollToHeading(heading)}
                style={{
                  paddingInlineStart: `${heading.depth * 16 + 12}px`,
                }}
                type="button"
              >
                <span
                  className="shrink-0 rounded px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider text-white"
                  style={{ backgroundColor: `var(${getCategoryVar(heading.category)})` }}
                >
                  {categoryLabel(heading.category)}
                </span>
                <span className="truncate">{heading.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
