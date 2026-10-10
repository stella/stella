import { useMemo, useState } from "react";

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

type LegalReaderBreadcrumbProps = {
  blocks: readonly Block[];
  content: HTMLElement | null;
  fallback?: ReaderBreadcrumbModel;
  viewport: HTMLElement | null;
};

export const LegalReaderBreadcrumb = ({
  blocks,
  content,
  fallback,
  viewport,
}: LegalReaderBreadcrumbProps) => {
  const model = useMemo(() => {
    const source = readerBreadcrumbPaths(blocks);
    return source.headings.length === 0 && fallback !== undefined
      ? fallback
      : source;
  }, [blocks, fallback]);
  const [path, setPath] = useState<readonly ReaderBreadcrumbSegment[]>([]);
  useExternalSyncEffect(() => {
    if (content === null || viewport === null) {
      return undefined;
    }
    return observeReaderBreadcrumb({
      content,
      viewport,
      anchors: model.headings.map(({ anchorId }) => anchorId),
      onAnchorChange: (anchorId) => {
        if (anchorId === null) {
          setPath([]);
          return;
        }
        const next = model.paths.get(anchorId);
        if (next === undefined) {
          panic("Visible heading has no breadcrumb path");
        }
        setPath(next);
      },
    });
  }, [content, model, viewport]);
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
