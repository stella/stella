import { courtAbbreviation } from "@stll/api-contract/court-abbreviations";
import type { DocumentIdentity } from "@stll/ui/document-identity-badge.logic";

/** Use the corpus's court reader, including ECLI precedence, on plain row values. */
export const decisionDocumentIdentity = ({
  country,
  court,
  ecli,
}: {
  country: string;
  court: string;
  ecli?: string | null | undefined;
}) =>
  ({
    kind: "decision",
    courtAbbreviation: courtAbbreviation({ country, court, ecli }) ?? null,
  }) as const satisfies DocumentIdentity;
