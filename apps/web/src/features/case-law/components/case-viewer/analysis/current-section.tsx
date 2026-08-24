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
 * click returns to where the section starts. Pinned at the top of the notes
 * column beside the text, inside the scroll container so `sticky` can hold
 * it; nothing shows until a heading has scrolled past the top.
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
    // Out of the flow (a sticky box of no height) at the top of the notes
    // column, so the notes keep their places and the text stays untouched.
    <div className="sticky top-0 z-10 h-0">
      <div
        aria-hidden={current === null}
        className={cn(
          "bg-background absolute inset-x-0 top-0 pb-2 transition-opacity duration-150",
          current === null ? "pointer-events-none opacity-0" : "opacity-100",
        )}
      >
        <button
          className="text-foreground-strong-muted hover:text-foreground flex w-full items-center gap-1.5 border-s-[3px] py-1 ps-2.5 pe-2 text-start font-sans text-xs"
          disabled={current === null}
          onClick={jumpBack}
          style={{
            borderInlineStartColor:
              current === null
                ? "transparent"
                : `var(${getCategoryVar(current.category)})`,
          }}
          title={t("caseLaw.analysis.backToSection")}
          type="button"
        >
          <span className="min-w-0 flex-1">
            {parent !== undefined && parent !== null && (
              <span className="text-muted-foreground block text-[0.7rem]">
                {parent.label}
              </span>
            )}
            <span className="block truncate font-medium">{current?.label}</span>
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
