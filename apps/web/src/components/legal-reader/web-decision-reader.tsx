import { useRef } from "react";

import {
  DecisionText,
  prepareDecisionTextPlacements,
} from "@stll/decision-reader/decision-text";
import type { DecisionTextProps } from "@stll/decision-reader/decision-text";
import { visibleDecisionBlocks } from "@stll/decision-reader/decision-text.logic";
import { useReaderAdapters } from "@stll/decision-reader/reader-adapters";
import {
  holdLanding,
  readerBlockByAnchor,
} from "@stll/decision-reader/reader-landing";
import type {
  CitationAnchorSource,
  DecisionProvisionAnchor,
  DecisionStatuteCitationAnchor,
} from "@stll/decision-reader/reader-types";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";

import { WebReaderProvider } from "@/components/legal-reader/web-reader-provider";
import type { DecisionReaderSurface } from "@/features/case-law/decision-reader-surfaces";
import { useProvisionPlacementTelemetry } from "@/features/case-law/use-provision-placement-telemetry";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useHydrated } from "@/hooks/use-hydrated";

export type WebDecisionReaderProps = Omit<
  DecisionTextProps,
  "placements" | "articleRef"
> & {
  surface: DecisionReaderSurface;
  citationAnchors?: readonly CitationAnchorSource[] | undefined;
  provisionAnchors?: readonly DecisionProvisionAnchor[] | undefined;
  statuteCitationAnchors?: readonly DecisionStatuteCitationAnchor[] | undefined;
};

type WebDecisionReaderContentProps = WebDecisionReaderProps & {
  articleRef?: undefined;
  placements?: undefined;
};

const NO_ANCHORS = [] as const;

const WebDecisionReaderContent = ({
  annotationAnchors = NO_ANCHORS,
  citationAnchors = NO_ANCHORS,
  provisionAnchors = NO_ANCHORS,
  statuteCitationAnchors = NO_ANCHORS,
  surface,
  ...props
}: WebDecisionReaderContentProps) => {
  const adapters = useReaderAdapters();
  const articleRef = useRef<HTMLElement>(null);
  const environmentHydrated = useHydrated();
  const hydrated = props.isHydrated ?? environmentHydrated;
  const ast = parseDocumentAst(props.decision.documentAst);
  const blocks = visibleDecisionBlocks(
    ast,
    props.decision.caseNumberType,
    props.decision.fulltext,
  );
  const placements = prepareDecisionTextPlacements({
    adapters,
    blocks,
    annotationAnchors: hydrated ? annotationAnchors : NO_ANCHORS,
    citationAnchors: hydrated ? citationAnchors : NO_ANCHORS,
    provisionAnchors: hydrated ? provisionAnchors : NO_ANCHORS,
    statuteCitationAnchors: hydrated ? statuteCitationAnchors : NO_ANCHORS,
  });
  useProvisionPlacementTelemetry({
    decisionId: props.decisionId,
    failures: placements.failures,
    surface,
  });
  const { landingAnchorId } = props;
  useExternalSyncEffect(() => {
    const article = articleRef.current;
    if (!article) {
      return undefined;
    }
    const target =
      landingAnchorId === undefined
        ? null
        : readerBlockByAnchor(article, landingAnchorId);
    if (!target) {
      return undefined;
    }
    for (
      let disclosure = target.closest("details");
      disclosure !== null;
      disclosure = disclosure.parentElement?.closest("details") ?? null
    ) {
      disclosure.open = true;
    }
    return holdLanding({ article, target });
  }, [landingAnchorId]);

  return (
    <DecisionText
      {...props}
      annotationAnchors={annotationAnchors}
      articleRef={articleRef}
      isHydrated={hydrated}
      placements={placements}
    />
  );
};

export const WebDecisionReader = (props: WebDecisionReaderProps) => (
  <WebReaderProvider>
    <WebDecisionReaderContent
      {...props}
      articleRef={undefined}
      placements={undefined}
    />
  </WebReaderProvider>
);
