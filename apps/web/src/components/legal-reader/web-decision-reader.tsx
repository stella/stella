import { useRef } from "react";

import { panic } from "better-result";

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
import { locateCitationSpans } from "@stll/legal-ast/citation-passage";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";

import { CitedDecisionLink } from "@/components/legal-reader/cited-decision-link";
import { WebReaderProvider } from "@/components/legal-reader/web-reader-provider";
import { decisionCitationCourtLabel } from "@/components/references/decision-citation-chip.logic";
import { decisionCitationPresentationsById } from "@/components/references/decision-citation-presentation.logic";
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
  const citations = hydrated ? citationAnchors : NO_ANCHORS;
  const presentations = decisionCitationPresentationsById(
    Object.values(locateCitationSpans({ blocks, citations })).flatMap((spans) =>
      spans.map(({ source: { decision } }) => ({
        decisionId: decision.id,
        courtShortCode: decisionCitationCourtLabel(decision),
      })),
    ),
  );
  const placements = prepareDecisionTextPlacements({
    adapters: {
      renderStatuteLink: adapters.renderStatuteLink,
      renderDecisionLink: ({ citation, ...linkProps }) => (
        <CitedDecisionLink
          {...linkProps}
          passage={{
            type: "citation",
            citation,
            textDecisionId: props.decisionId,
          }}
          presentation={
            presentations.get(linkProps.decision.id) ??
            panic("Reader citation missing collected identity")
          }
        />
      ),
    },
    blocks,
    annotationAnchors: hydrated ? annotationAnchors : NO_ANCHORS,
    citationAnchors: citations,
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
