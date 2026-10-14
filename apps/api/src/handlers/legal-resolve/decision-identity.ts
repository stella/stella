import { panic } from "better-result";

import { normalizeCountry } from "@stll/agent-input";
import {
  parseDecisionQuery,
  resolveDecisionIdentity,
} from "@stll/api-contract/decision-query-intent";
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
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { decisionDocketGrammarForCountry } from "@/api/lib/legal-search/adapter-manifest";

/**
 * Which decision an identifier names in one admitted country, read by exact
 * identity only: never the decision text, never a search.
 */
type DecisionIdentityLookup =
  | { status: "incomplete_identifier"; missing: readonly string[] }
  | { status: "country_unavailable" }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: readonly DecisionIdentityRow[] }
  | { status: "unique"; decision: DecisionIdentityRow };

type LookupDecisionIdentityOptions = {
  country: string;
  identifier: string;
  lookup?: typeof lookupDecisionsByIdentity;
  /**
   * How a docket that names a whole file may still name one decision, for a
   * caller that reads a citation in context rather than an identifier alone:
   * the decision dated as the text dates it, or, with no date written, the
   * file's only decision. Absent, such a docket stays incomplete.
   */
  docketFamily?: { citedDecisionDate: string | null };
};

/**
 * The one decision of a docket's file a citation names: the one dated as
 * the citation dates it, or the only one when it names no date. Null when
 * the file's decisions leave it open.
 */
const familyDecision = (
  candidates: readonly DecisionIdentityRow[],
  citedDecisionDate: string | null,
): DecisionIdentityRow | null => {
  const named =
    citedDecisionDate === null
      ? candidates
      : candidates.filter(
          ({ decisionDate }) => decisionDate === citedDecisionDate,
        );
  const [only, ...rest] = named;
  return only !== undefined && rest.length === 0 ? only : null;
};

/**
 * The one reading of "which decision does this identifier name": the
 * country's docket and reporter grammars parse it, the corpus is probed by
 * that identity, and `resolveDecisionIdentity` decides. A file that may hold
 * several decisions and names no sheet stays incomplete; exact identity never
 * picks one of its candidates. The legal resolver and the chat citation
 * linker both read decisions through it, so a docket one links is the one
 * the other resolves.
 */
export const lookupDecisionIdentity = async ({
  country: countryInput,
  identifier,
  lookup = lookupDecisionsByIdentity,
  docketFamily,
}: LookupDecisionIdentityOptions): Promise<DecisionIdentityLookup> => {
  if (identifier.trim().length === 0) {
    return { status: "incomplete_identifier", missing: ["identifier"] };
  }
  const normalized = normalizeCountry(countryInput);
  if (!normalized.ok) {
    return { status: "country_unavailable" };
  }
  const country = normalized.value.alpha3;
  if (
    !isPublicCountry(country) ||
    PUBLIC_COUNTRY_CAPABILITIES[country] !== "admitted"
  ) {
    return { status: "country_unavailable" };
  }
  const grammar = decisionDocketGrammarForCountry(country);
  const reporters = decisionReporterGrammarForJurisdiction(country);
  const intent = parseDecisionQuery(identifier, { grammar, reporters });
  if (intent.type !== "identifier") {
    return { status: "not_found" };
  }
  const rows = await lookup({
    caseLawDb: caseLawPublicReadDb,
    country,
    locator: decisionIdentityLocatorOf(intent),
  });
  const resolution = resolveDecisionIdentity(intent, rows, { reporters });
  switch (resolution.status) {
    case "none":
      return { status: "not_found" };
    case "ambiguous": {
      if (resolution.reason === "selector_unmatched") {
        return { status: "not_found" };
      }
      const decision =
        docketFamily === undefined
          ? null
          : familyDecision(
              resolution.candidates,
              docketFamily.citedDecisionDate,
            );
      return decision === null
        ? { status: "ambiguous", candidates: resolution.candidates }
        : { status: "unique", decision };
    }
    case "unique":
      return { status: "unique", decision: resolution.decision };
    case "incomplete_identifier": {
      const decision =
        docketFamily === undefined
          ? null
          : familyDecision(
              resolution.candidates,
              docketFamily.citedDecisionDate,
            );
      return decision === null
        ? { status: "incomplete_identifier", missing: resolution.missing }
        : { status: "unique", decision };
    }
    default:
      resolution satisfies never;
      return panic("Unhandled decision identity resolution");
  }
};
