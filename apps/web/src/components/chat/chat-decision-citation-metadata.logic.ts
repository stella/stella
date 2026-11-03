import { panic } from "better-result";

import { resolveLegalCitationLinks } from "@stll/api-contract/legal-citation-links";

import type { ExternalSourceReference } from "@/components/chat/external-source-store";
import { decisionCitationMetadata } from "@/components/references/decision-citation-chip.logic";
import type { DecisionCitationMetadata } from "@/components/references/decision-citation-chip.logic";
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
      url: source.url,
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
        case "items":
          return decisionCitationMetadata(read.view.items);
        default:
          read.view satisfies never;
          return panic("Unhandled citation query state");
      }
    default:
      read satisfies never;
      return panic("Unhandled citation metadata read");
  }
};
