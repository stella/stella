import { useMemo, useState } from "react";

import { panic } from "better-result";

import { readerBlockByAnchor } from "@stll/decision-reader/reader-landing";
import type { Block } from "@stll/legal-ast/document-ast";

import { useExternalSyncEffect } from "@/hooks/use-effect";

import { ReaderBreadcrumb } from "./reader-breadcrumb";
import { readerBreadcrumbPaths } from "./reader-breadcrumb-paths";
import {
  observeReaderBreadcrumb,
  scrollReaderBreadcrumbToHeading,
} from "./reader-breadcrumb-scroll";
import type { ReaderBreadcrumbSegment } from "./reader-breadcrumb.logic";
import { readerContents } from "./reader-contents.logic";
import type { ReaderAnalysisOutline } from "./reader-contents.logic";

type LegalReaderBreadcrumbProps = {
  blocks: readonly Block[];
  content: HTMLElement | null;
  analysis?: ReaderAnalysisOutline | undefined;
  viewport: HTMLElement | null;
};

type ReaderPosition = {
  anchorId: string;
  trail: readonly ReaderBreadcrumbSegment[];
};

// Before the first row, one stable empty trail keeps the bar's measurement
// from re-running on every render.
const NO_TRAIL: readonly ReaderBreadcrumbSegment[] = [];

export const LegalReaderBreadcrumb = ({
  blocks,
  content,
  analysis,
  viewport,
}: LegalReaderBreadcrumbProps) => {
  const headings = useMemo(() => readerBreadcrumbPaths(blocks), [blocks]);
  const contents = useMemo(
    () =>
      readerContents({
        anchorOrder: blocks.map(({ anchorId }) => anchorId),
        headings,
        analysis,
      }),
    [blocks, headings, analysis],
  );
  const [position, setPosition] = useState<ReaderPosition | null>(null);
  useExternalSyncEffect(() => {
    if (content === null || viewport === null) {
      return undefined;
    }
    return observeReaderBreadcrumb({
      content,
      viewport,
      anchors: contents.rows.map(({ anchorId }) => anchorId),
      onAnchorChange: (anchorId) => {
        if (anchorId === null) {
          setPosition(null);
          return;
        }
        const trail = contents.trails.get(anchorId);
        if (trail === undefined) {
          panic("Visible contents row has no breadcrumb trail");
        }
        // Sections streaming in rebuild the rows but keep each heading's
        // trail, so the bar and its live region stay as they are.
        setPosition((previous) =>
          previous?.anchorId === anchorId && previous.trail === trail
            ? previous
            : { anchorId, trail },
        );
      },
    });
  }, [content, contents, viewport]);
  return (
    <ReaderBreadcrumb
      activeAnchorId={position?.anchorId ?? null}
      path={position?.trail ?? NO_TRAIL}
      rows={contents.rows}
      onJump={(anchorId) => {
        if (content === null || viewport === null) {
          return;
        }
        const target = readerBlockByAnchor(content, anchorId);
        if (target === null) {
          return;
        }
        scrollReaderBreadcrumbToHeading({ viewport, target });
      }}
    />
  );
};
