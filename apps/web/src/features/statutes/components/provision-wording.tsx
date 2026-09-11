import { useRef } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  parseDocumentAst,
  resolveDocumentAnchor,
} from "@stll/legal-ast/document-ast";
import { Skeleton } from "@stll/ui/skeleton";

import { BlockRenderer } from "@/components/legal-reader/document-ast-text";
import { provisionBlocks } from "@/features/statutes/provision-preview";
import { statuteOptions } from "@/features/statutes/queries/statutes";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { forceReflow } from "@/lib/utils";

// The statute reader carries no in-page find bar, so every block renders
// with an empty highlight set.
const NO_RANGES = {};
const NO_ACTIVE_MATCH = -1;

const READER_STYLE = {
  fontFamily: "var(--reader-body-font)",
  fontSize: "var(--reader-body-size)",
  lineHeight: "var(--reader-body-line-height)",
} as const;

type ProvisionWordingProps = {
  /** The provision heading's anchor. */
  anchorId: string;
  documentId: string;
  /** The subdivision to bring into view and flash; the heading by default. */
  highlightAnchorId: string | undefined;
};

/**
 * The provision's own text, as the statute reader prints it, landed on the
 * subdivision the reader came for. The flash is the reader's own
 * `[data-highlight]` animation, so a provision opened from a decision reads
 * the way a jump inside the statute does.
 */
export const ProvisionWording = ({
  anchorId,
  documentId,
  highlightAnchorId,
}: ProvisionWordingProps) => {
  const t = useTranslations();
  const containerRef = useRef<HTMLElement>(null);
  const {
    data: statute,
    isError,
    isPending,
  } = useQuery(statuteOptions(documentId));
  const ast =
    statute === undefined ? null : parseDocumentAst(statute.documentAst);
  const blocks = ast === null ? null : provisionBlocks(ast.blocks, anchorId);
  const requestedTarget = highlightAnchorId ?? anchorId;
  const target =
    ast === null
      ? null
      : (resolveDocumentAnchor(ast.blocks, requestedTarget)?.anchorId ?? null);
  const ready = blocks !== null && blocks.length > 0;

  useExternalSyncEffect(() => {
    if (!ready || target === null) {
      return;
    }
    const element = containerRef.current?.querySelector<HTMLElement>(
      `[data-anchor="${CSS.escape(target)}"]`,
    );
    if (!element) {
      return;
    }
    element.scrollIntoView({ behavior: "instant", block: "center" });
    delete element.dataset["highlight"];
    forceReflow(element);
    element.dataset["highlight"] = "";
  }, [ready, target]);

  if (isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
      </div>
    );
  }

  if (isError || blocks === null) {
    return (
      <p className="text-muted-foreground text-xs">
        {t("statutes.provisionHistoryUnavailable")}
      </p>
    );
  }

  return (
    <article
      className="reader-paper reader-statute text-card-foreground text-start"
      lang={statute.language}
      ref={containerRef}
      style={READER_STYLE}
    >
      {blocks.map((block) => (
        <BlockRenderer
          activeMatchIndex={NO_ACTIVE_MATCH}
          anchorPresentation="embedded"
          block={block}
          key={block.id}
          rangesByPieceId={NO_RANGES}
          variant="statute"
        />
      ))}
    </article>
  );
};
