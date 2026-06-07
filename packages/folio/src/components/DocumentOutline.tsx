/**
 * Document outline rail for the docx editor.
 *
 * Thin adapter over the shared `@stll/ui` OutlineRail: it supplies the
 * editor-specific position source (heading PM position over the full document
 * size, since the paged editor virtualises pages) and active-heading detection
 * (walking the rendered anchors in the virtualisation buffer). The rail itself
 * — ticks, hover popover, collapsible tree — is shared with the rest of the app.
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

import {
  OutlineRail,
  type OutlineItem,
} from "@stll/ui/components/outline-rail";

import { findBodyPmAnchors } from "../core/layout-bridge/findBodyPmSpans";
import type { HeadingInfo } from "../core/utils/headingCollector";

export type DocumentOutlineProps = {
  headings: HeadingInfo[];
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  topOffset: number;
  /** Total ProseMirror document content size — drives proportional tick
   *  placement when pages are virtualised. */
  docSize: number;
  onHeadingClick: (pmPos: number) => void;
};

export const DocumentOutline: React.FC<DocumentOutlineProps> = ({
  headings,
  scrollContainerRef,
  topOffset,
  docSize,
  onHeadingClick,
}) => {
  const [activeId, setActiveId] = useState<string | null>(null);
  // Suppress the scroll-driven active detector briefly after a click so the
  // in-flight smooth-scroll doesn't revert the highlight to the prior heading.
  const manualLockUntil = useRef(0);

  const items = useMemo<OutlineItem[]>(
    () =>
      headings.map((heading) => {
        const item: OutlineItem = {
          id: String(heading.pmPos),
          label: heading.text,
          level: heading.level,
        };
        if (typeof heading.pageNumber === "number") {
          item.meta = String(heading.pageNumber);
        }
        return item;
      }),
    [headings],
  );

  const pctByPmPos = useMemo(() => {
    const map = new Map<string, number>();
    if (docSize > 0) {
      for (const heading of headings) {
        map.set(
          String(heading.pmPos),
          Math.min(99, Math.max(1, (heading.pmPos / docSize) * 100)),
        );
      }
    }
    return map;
  }, [headings, docSize]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || headings.length === 0) {
      return undefined;
    }
    const compute = () => {
      if (Date.now() < manualLockUntil.current) {
        return;
      }
      const anchors = findBodyPmAnchors(container);
      if (anchors.length === 0) {
        return;
      }
      const containerTop = container.getBoundingClientRect().top;
      const threshold = container.scrollTop + container.clientHeight / 2;
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

      let next: string | null = null;
      for (const heading of headings) {
        let candidate: { pm: number; top: number } | undefined;
        for (const offset of offsets) {
          if (offset.pm >= heading.pmPos) {
            candidate = offset;
            break;
          }
        }
        if (candidate && candidate.top <= threshold) {
          next = String(heading.pmPos);
        }
      }
      setActiveId(next);
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
  }, [scrollContainerRef, headings]);

  const handleJump = useCallback(
    (id: string) => {
      setActiveId(id);
      manualLockUntil.current = Date.now() + 900;
      onHeadingClick(Number(id));
    },
    [onHeadingClick],
  );

  if (headings.length < 2) {
    return null;
  }

  return (
    <OutlineRail
      activeId={activeId}
      ariaLabel="Document outline"
      items={items}
      onJump={handleJump}
      panelWidth={320}
      resolvePct={(id) => pctByPmPos.get(id) ?? null}
      scrollContainerRef={scrollContainerRef}
      topOffset={topOffset}
    />
  );
};
