import { panic } from "better-result";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import { resolveLegalCitationLinks } from "@stll/api-contract/legal-citation-links";

import type { ExternalSourceReference } from "@/components/chat/external-source-store";
import type { DecisionCitationMetadata } from "@/components/references/decision-citation-chip";
import { decisionCitationCourtLabel } from "@/components/references/decision-citation-chip.logic";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import type { QueryView } from "@/lib/query-view.logic";

export type DecisionCitationRead =
  | { type: "source"; metadata: DecisionCitationMetadata }
  | { type: "query"; view: QueryView<PublicCaseLawDecision, unknown> };

type SourceCitationMetadataOptions = {
  decisionId: string;
  sources: readonly ExternalSourceReference[];
  appOrigins: ReadonlySet<string>;
};

export const sourceCitationMetadata = ({
  decisionId,
  sources,
  appOrigins,
}: SourceCitationMetadataOptions): DecisionCitationMetadata | null => {
  for (const source of sources) {
    const reference = source.caseLawDecision;
    if (
      reference?.decisionId !== decisionId ||
      reference.citation === undefined
    ) {
      continue;
    }
    const links = resolveLegalCitationLinks({
      appUrl: source.appUrl ?? source.url,
      sourceUrl: source.sourceUrl ?? source.url,
      appOrigins,
    });
    if (links.type !== "decision") {
      continue;
    }
    return {
      ...reference.citation,
      decisionId,
      caseNumber: reference.caseNumber,
      readerUrl: links.url,
      originalUrl: links.source_url ?? null,
    };
  }
  return null;
};

export const readyCitationMetadata = (
  read: DecisionCitationRead,
): DecisionCitationMetadata | null => {
  switch (read.type) {
    case "source":
      return read.metadata;
    case "query":
      switch (read.view.type) {
        case "pending":
        case "error":
        case "empty":
          return null;
        case "items": {
          const decision = read.view.items;
          return {
            decisionId: decision.id,
            court: decision.court,
            courtShortCode: decisionCitationCourtLabel(decision),
            caseNumber: decision.caseNumber,
            decisionDate: decision.decisionDate,
            readerUrl: createCaseLawDecisionPath(
              createCaseLawDecisionRouteParams({
                caseNumber: decision.caseNumber,
                country: decision.country,
                court: decision.court,
                decisionId: decision.id,
                language: decision.language,
                languageAlternates: decision.languageAlternates,
                slug: decision.slug,
              }),
            ),
            originalUrl: decision.sourceUrl ?? decision.documentUrl ?? null,
          };
        }
        default:
          read.view satisfies never;
          return panic("Unhandled citation query state");
      }
    default:
      read satisfies never;
      return panic("Unhandled citation metadata read");
  }
};
