import { useState } from "react";
import type { RefObject } from "react";

import { ChevronUpIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import type { FlatAnalysisHeading } from "@/features/case-law/components/case-viewer/analysis/types";
import { getCategoryVar } from "@/features/case-law/components/case-viewer/analysis/types";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { forceReflow } from "@/lib/utils";

/** How far a heading may sit below the top edge and still be "current". */
const TOP_TOLERANCE_PX = 12;

type CurrentSectionProps = {
  /** Where each heading is shown in the text (its first annotation). */
  anchorById: ReadonlyMap<string, string>;
  headings: readonly FlatAnalysisHeading[];
  scrollContainerRef: RefObject<HTMLElement | null>;
};

/**
 * The AI-generated heading of the passage under the reader's eye, held at
 * the top of the text while they scroll, with its parent for the path. A
 * click returns to where the section starts. Placed at the top of the text
 * column, inside the scroll container so `sticky` can hold it; nothing
 * shows until a heading has scrolled past the top.
 */
export const CurrentSection = ({
  anchorById,
  headings,
  scrollContainerRef,
}: CurrentSectionProps) => {
  const t = useTranslations();
  const [currentId, setCurrentId] = useState<string | null>(null);

  useExternalSyncEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || headings.length === 0) {
      return undefined;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = container.getBoundingClientRect().top + TOP_TOLERANCE_PX;
      let current: string | null = null;
      for (const heading of headings) {
        const anchorId = anchorById.get(heading.id);
        if (anchorId === undefined) {
          continue;
        }
        const element = container.querySelector(`#${CSS.escape(anchorId)}`);
        if (element === null) {
          continue;
        }
        if (element.getBoundingClientRect().top > top) {
          // Headings are in reading order: the first one still below the
          // top ends the search.
          break;
        }
        current = heading.id;
      }
      setCurrentId(current);
    };
    const onScroll = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(measure);
      }
    };
    measure();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      container.removeEventListener("scroll", onScroll);
    };
  }, [anchorById, headings, scrollContainerRef]);

  const index = headings.findIndex((heading) => heading.id === currentId);
  const current = index === -1 ? null : headings[index];
  const parent =
    current === null || current.depth === 0
      ? null
      : headings
          .slice(0, index)
          .findLast((heading) => heading.depth === current.depth - 1);

  const jumpBack = () => {
    const container = scrollContainerRef.current;
    const anchorId = current === null ? undefined : anchorById.get(current.id);
    if (!container || anchorId === undefined) {
      return;
    }
    const element = container.querySelector<HTMLElement>(
      `#${CSS.escape(anchorId)}`,
    );
    if (!element) {
      return;
    }
    container.scrollTo({
      top:
        element.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop,
      behavior: "instant",
    });
    delete element.dataset["highlight"];
    forceReflow(element);
    element.dataset["highlight"] = "";
  };

  return (
    // Out of the flow (a sticky box of no height), so the text keeps its
    // place and the bar lies over its top edge, on the paper's own colour.
    <div className="sticky top-0 z-10 -mx-4 h-0 max-sm:-mx-3">
      <div
        aria-hidden={current === null}
        className={cn(
          "reader-paper border-border/60 absolute inset-x-0 top-0 border-b transition-opacity duration-150",
          current === null ? "pointer-events-none opacity-0" : "opacity-100",
        )}
      >
        <button
          className="text-foreground-strong-muted hover:text-foreground flex w-full items-center gap-2 px-4 py-1.5 text-start font-sans text-xs max-sm:px-3"
          disabled={current === null}
          onClick={jumpBack}
          title={t("caseLaw.analysis.backToSection")}
          type="button"
        >
          {current !== null && (
            <span
              aria-hidden="true"
              className="h-3 w-[3px] shrink-0 rounded-full"
              style={{
                backgroundColor: `var(${getCategoryVar(current.category)})`,
              }}
            />
          )}
          <span className="min-w-0 flex-1 truncate">
            {parent !== undefined && parent !== null && (
              <span className="text-muted-foreground">{parent.label} › </span>
            )}
            {current?.label}
          </span>
          <ChevronUpIcon
            aria-hidden="true"
            className="text-foreground-disabled size-3.5 shrink-0"
          />
        </button>
      </div>
    </div>
  );
};
