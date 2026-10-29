import type { ComponentProps } from "react";

import {
  DECISION_TEXT_AVAILABILITY,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import { MISSING_BODY_REASON } from "@stll/decision-reader/decision-body-state.logic";
import { NO_QUERY_MARK_TOKENS } from "@stll/decision-reader/query-marks";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { MissingDecisionBody } from "@/features/case-law/components/case-viewer/decision-body-state";
import { CaseNumberCell } from "@/features/case-law/components/decision-cells";
import type {
  Decision,
  DecisionRenderContext,
} from "@/features/case-law/components/decision-cells";

const metadataDecision = {
  id: "00000000-0000-4000-8000-000000000895",
  caseNumber: "40 Cdo 100/2026",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  slug: null,
  ecli: null,
  court: "Fixture court",
  courtAbbreviation: "FC",
  courtTier: "supreme",
  country: "CZE",
  language: "cs",
  languageAlternates: [],
  decisionDate: "2026-01-15",
  decisionType: "resolution",
  headnote: {
    type: TEXT_FIELD_TYPE.PRESENT,
    text: "Synthetic publisher summary retained without the decision text.",
    truncated: false,
  },
  citationCount: 0,
  textAvailability: DECISION_TEXT_AVAILABILITY.METADATA_ONLY,
} satisfies Decision;

const availableDecision = {
  ...metadataDecision,
  id: "00000000-0000-4000-8000-000000000896",
  caseNumber: "40 Cdo 101/2026",
  textAvailability: DECISION_TEXT_AVAILABILITY.AVAILABLE,
} satisfies Decision;

const context = {
  identityLineFields: ["court", "date"],
  queryTokens: NO_QUERY_MARK_TOKENS,
  searchQuery: undefined,
  contentMode: "tight",
  expandedHeadnoteIds: new Set<string>(),
  onToggleHeadnote: () => undefined,
} satisfies DecisionRenderContext;

const missingBody = {
  reason: MISSING_BODY_REASON.unavailable,
  onRetry: () => undefined,
} satisfies ComponentProps<typeof MissingDecisionBody>;

export const CaseLawTextAvailabilityPlayground = () => (
  <div
    className="mx-auto w-full max-w-3xl space-y-8 p-4"
    data-playground-section="case-law-text-availability"
  >
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Search results</h2>
      <div className="divide-border divide-y rounded-md border">
        {[metadataDecision, availableDecision].map((decision) => (
          <div className="p-4" key={decision.id}>
            <CaseNumberCell context={context} decision={decision} />
          </div>
        ))}
      </div>
    </section>
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Metadata-only decision reader</h2>
      <div className="rounded-md border">
        <MissingDecisionBody {...missingBody} />
      </div>
    </section>
  </div>
);
