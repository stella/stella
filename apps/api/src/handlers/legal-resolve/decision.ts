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
import { buildCaseLawDecisionUrl } from "@/api/lib/legal-search/public-law-app-urls";
import { LIMITS } from "@/api/lib/limits";

type DecisionResolverDependencies = {
  lookup?: typeof lookupDecisionsByIdentity;
  read?: typeof readDecisionReaderSource;
};

type ResolvedDecisionDocument = Extract<
  Extract<LegalResolveResponse, { status: "resolved" }>["document"],
  { kind: "decision" }
>;

const decisionText = (
  content: Awaited<ReturnType<typeof readDecisionReaderSource>>,
): ResolvedDecisionDocument["text"] => {
  if (content?.status !== "read") {
    return { status: "unavailable" };
  }
  if (content.textAccess === "readable") {
    return { status: "readable", blocks: content.ast?.blocks ?? [] };
  }
  return { status: "withheld", reason: "licence" };
};

const candidate = (row: DecisionIdentityRow) => ({
  decisionId: row.id,
  identifier: row.ecli ?? row.caseNumber,
  label: `${row.court}, ${row.decisionDate ?? row.caseNumber}`,
  readerUrl: buildCaseLawDecisionUrl({
    caseNumber: row.caseNumber,
    country: row.country,
    court: row.court,
    decisionId: row.id,
    language: row.language,
    languageAlternates: row.languageAlternates,
    slug: row.slug,
  }),
});

export const resolveDecision = async (
  countryInput: string,
  identifier: string,
  {
    lookup = lookupDecisionsByIdentity,
    read = readDecisionReaderSource,
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
      const readerUrl = buildCaseLawDecisionUrl({
        caseNumber: row.caseNumber,
        country: row.country,
        court: row.court,
        decisionId: row.id,
        language: row.language,
        languageAlternates: row.languageAlternates,
        slug: row.slug,
      });
      return {
        status: "resolved",
        document: {
          kind: "decision",
          decisionId: row.id,
          identifier: row.ecli ?? row.caseNumber,
          country: row.country,
          caseNumber: row.caseNumber,
          court: row.court,
          decisionDate: row.decisionDate,
          ecli: row.ecli,
          readerUrl,
          text: decisionText(content),
        },
      };
    }
    default:
      resolution satisfies never;
      return panic("Unhandled decision identity resolution");
  }
};
