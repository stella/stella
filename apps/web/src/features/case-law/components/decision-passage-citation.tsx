import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import { BidiText } from "@stll/ui/bidi-text";

import { DecisionCitationChip } from "@/components/references/decision-citation-chip";
import { decisionCitationCourtLabel } from "@/components/references/decision-citation-chip.logic";
import type { Decision } from "@/features/case-law/components/decision-cells";
import type { Citation } from "@/lib/citations";

type DecisionPassageCitationProps = {
  decision: Decision;
  citation: Extract<Citation, { kind: "decision-passage" }>;
  onOpen: (anchorId: string) => void;
};

/**
 * The passage of a decision an answer leaned on. Pressing it opens the
 * decision at that paragraph with the reader's highlight on it, the way a
 * page chip opens a file at its page.
 */
export const DecisionPassageCitation = ({
  citation,
  decision,
  onOpen,
}: DecisionPassageCitationProps) => {
  const readerUrl = createCaseLawDecisionPath(
    createCaseLawDecisionRouteParams({
      caseNumber: decision.caseNumber,
      country: decision.country,
      court: decision.court,
      decisionId: decision.id,
      language: decision.language,
      languageAlternates: decision.languageAlternates,
      slug: decision.slug,
    }),
  );
  return (
    <>
      <BidiText as="span">{citation.excerpt}</BidiText>{" "}
      <DecisionCitationChip
        decision={{
          decisionId: decision.id,
          court: decision.court,
          courtShortCode: decisionCitationCourtLabel(decision),
          caseNumber: decision.caseNumber,
          decisionDate: decision.decisionDate,
          readerUrl: `${readerUrl}#${encodeURIComponent(citation.anchorId)}`,
          originalUrl: decision.sourceUrl ?? null,
        }}
        passage={citation.excerpt}
        onOpen={() => onOpen(citation.anchorId)}
      />
    </>
  );
};
