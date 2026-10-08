import { useMemo, useState } from "react";
import type { RefObject } from "react";

import { panic } from "better-result";

import type { Block } from "@stll/legal-ast/document-ast";

import { useExternalSyncEffect } from "@/hooks/use-effect";

import { ReaderBreadcrumb } from "./reader-breadcrumb";
import { readerBreadcrumbPaths } from "./reader-breadcrumb-paths";
import {
  observeReaderBreadcrumb,
  READER_BREADCRUMB_CLEARANCE,
} from "./reader-breadcrumb-scroll";
import type { ReaderBreadcrumbSegment } from "./reader-breadcrumb.logic";
import { readerBlockByAnchor } from "./reader-landing";

type LegalReaderBreadcrumbProps = {
  blocks: readonly Block[];
  contentRef: RefObject<HTMLElement | null>;
  viewportRef: RefObject<HTMLElement | null>;
};

export const LegalReaderBreadcrumb = ({
  blocks,
  contentRef,
  viewportRef,
}: LegalReaderBreadcrumbProps) => {
  const model = useMemo(() => readerBreadcrumbPaths(blocks), [blocks]);
  const [path, setPath] = useState<readonly ReaderBreadcrumbSegment[]>([]);
  useExternalSyncEffect(() => {
    const content = contentRef.current;
    const viewport = viewportRef.current;
    if (content === null || viewport === null) {
      return;
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
          return panic("Visible heading has no breadcrumb path");
        }
        setPath(next);
      },
    });
  }, [contentRef, model, viewportRef]);
  return (
    <ReaderBreadcrumb
      path={path}
      headings={model.headings}
      onJump={(anchorId) => {
        const content = contentRef.current;
        const viewport = viewportRef.current;
        if (content === null || viewport === null) {
          return;
        }
        const target = readerBlockByAnchor(content, anchorId);
        if (target === null) {
          return;
        }
        viewport.scrollTo({
          top:
            viewport.scrollTop +
            target.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top -
            READER_BREADCRUMB_CLEARANCE,
        });
      }}
    />
  );
};
