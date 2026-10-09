import { panic } from "better-result";

import { normalizeCountry } from "@stll/agent-input";
import {
  parseDecisionQuery,
  resolveDecisionIdentity,
} from "@stll/api-contract/decision-query-intent";
import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";
import {
  isPublicCountry,
  PUBLIC_COUNTRY_CAPABILITIES,
} from "@stll/api-contract/public-country-capability";
import { decisionReporterGrammarForJurisdiction } from "@stll/api-contract/us-reporter-citation";

import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import {
  decisionIdentityLocatorOf,
  lookupDecisionsByIdentity,
} from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { decisionDocketGrammarForCountry } from "@/api/lib/legal-search/adapter-manifest";
import { LIMITS } from "@/api/lib/limits";

type DecisionResolverDependencies = {
  lookup?: typeof lookupDecisionsByIdentity;
  read?: (input: Parameters<typeof readDecisionReaderSource>[0]) => Promise<{
    status: "read";
    textAccess: "readable" | "withheld";
    ast?: { blocks?: unknown[] } | null;
  } | null>;
};

const readDecision = async (
  input: Parameters<typeof readDecisionReaderSource>[0],
) => {
  const result = await readDecisionReaderSource(input);
  if (result?.status !== "read") {
    return null;
  }
  return {
    status: result.status,
    textAccess: result.textAccess,
    ast: result.ast,
  };
};

const candidate = (row: DecisionIdentityRow) => ({
  identifier: row.ecli ?? row.caseNumber,
  label: `${row.court}, ${row.decisionDate ?? row.caseNumber}`,
  ...(row.slug === null ? {} : { url: row.slug }),
});

export const resolveDecision = async (
  countryInput: string,
  identifier: string,
  {
    lookup = lookupDecisionsByIdentity,
    read = readDecision,
  }: DecisionResolverDependencies = {},
): Promise<LegalResolveResponse> => {
  if (identifier.trim().length === 0) {
    return { status: "incomplete_identifier", missing: ["identifier"] };
  }
  const normalized = normalizeCountry(countryInput);
  if (!normalized.ok) {
    return { status: "not_found", reason: "no_exact_identity" };
  }
  const country = normalized.value.alpha3;
  if (!isPublicCountry(country)) {
    return { status: "country_unavailable" };
  }
  if (PUBLIC_COUNTRY_CAPABILITIES[country] !== "admitted") {
    return { status: "country_unavailable" };
  }
  const grammar = decisionDocketGrammarForCountry(country);
  const reporters = decisionReporterGrammarForJurisdiction(country);
  const intent = parseDecisionQuery(identifier, { grammar, reporters });
  if (intent.type !== "identifier") {
    return { status: "not_found", reason: "no_exact_identity" };
  }
  const rows = await lookup({
    caseLawDb: caseLawPublicReadDb,
    country,
    locator: decisionIdentityLocatorOf(intent),
  });
  const resolution = resolveDecisionIdentity(intent, rows, { reporters });
  switch (resolution.status) {
    case "none":
      return { status: "not_found", reason: "no_exact_identity" };
    case "ambiguous":
      if (resolution.reason === "selector_unmatched") {
        return { status: "not_found", reason: "no_exact_identity" };
      }
      return {
        status: "ambiguous",
        candidates: resolution.candidates
          .slice(0, LIMITS.caseLawLookupCandidatesMax)
          .map(candidate),
      };
    case "unique": {
      const row = resolution.decision;
      const content = await read({
        decisionId: row.id,
        phase: "blocks",
        audience: "model",
      });
      const text =
        content?.status === "read" && content.textAccess === "readable"
          ? { blocks: content.ast?.blocks ?? [] }
          : { textWithheld: "licence" as const };
      return {
        status: "resolved",
        document: {
          identifier: row.ecli ?? row.caseNumber,
          country: row.country,
          metadata: {
            caseNumber: row.caseNumber,
            court: row.court,
            decisionDate: row.decisionDate,
            ecli: row.ecli,
          },
          ...text,
        },
      };
    }
    default:
      resolution satisfies never;
      return panic("Unhandled decision identity resolution");
  }
};
