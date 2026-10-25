import { useState } from "react";

import { panic } from "better-result";

import { readerBlockByAnchor } from "@stll/decision-reader/reader-landing";
import type { Block } from "@stll/legal-ast/document-ast";

import { useExternalSyncEffect } from "@/hooks/use-effect";

import { ReaderBreadcrumb } from "./reader-breadcrumb";
import { readerBreadcrumbPaths } from "./reader-breadcrumb-paths";
import type { ReaderBreadcrumbModel } from "./reader-breadcrumb-paths";
import {
  observeReaderBreadcrumb,
  scrollReaderBreadcrumbToHeading,
} from "./reader-breadcrumb-scroll";
import type { ReaderBreadcrumbSegment } from "./reader-breadcrumb.logic";

// The decision's own headings, or the analysis outline when it has none.
const breadcrumbModel = (
  blocks: readonly Block[],
  fallback: ReaderBreadcrumbModel | undefined,
): ReaderBreadcrumbModel => {
  const source = readerBreadcrumbPaths(blocks);
  return source.headings.length === 0 && fallback !== undefined
    ? fallback
    : source;
};

type LegalReaderBreadcrumbProps = {
  blocks: readonly Block[];
  content: HTMLElement | null;
  fallback?: ReaderBreadcrumbModel | undefined;
  viewport: HTMLElement | null;
};

export const LegalReaderBreadcrumb = ({
  blocks,
  content,
  fallback,
  viewport,
}: LegalReaderBreadcrumbProps) => {
  const model = breadcrumbModel(blocks, fallback);
  const [path, setPath] = useState<readonly ReaderBreadcrumbSegment[]>([]);
  useExternalSyncEffect(() => {
    if (content === null || viewport === null) {
      return undefined;
    }
    // Derived from the props here too, so the subscription depends on the
    // inputs exhaustive-deps can see rather than on a render-time value.
    const current = breadcrumbModel(blocks, fallback);
    return observeReaderBreadcrumb({
      content,
      viewport,
      anchors: current.headings.map(({ anchorId }) => anchorId),
      onAnchorChange: (anchorId) => {
        if (anchorId === null) {
          setPath([]);
          return;
        }
        const next = current.paths.get(anchorId);
        if (next === undefined) {
          panic("Visible heading has no breadcrumb path");
        }
        setPath(next);
      },
    });
  }, [blocks, content, fallback, viewport]);
  return (
    <ReaderBreadcrumb
      path={path}
      headings={model.headings}
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
