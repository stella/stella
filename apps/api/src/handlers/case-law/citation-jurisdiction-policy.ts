/**
 * Which decisions a citation written in one jurisdiction is allowed to reach.
 *
 * A case number is only unique inside its own court system, so the resolver
 * has to know whose corpus a citation may be matched against. That is not one
 * rule: a Czech judgment citing "C-106/89" means the Court of Justice, while
 * the same docket grammar in another national corpus means an unrelated case.
 * Encoding it as `cited.country = citing.country OR cited.country = 'EU'`
 * would bake one region's court hierarchy into the engine, and the next
 * jurisdiction with different supranational membership (or none) would have to
 * edit the resolver rather than declare a policy.
 *
 * So the engine knows only "join on the key, then filter candidates by the
 * citing jurisdiction's declared reach". Everything jurisdiction-flavoured
 * lives here, as a map that is total over `CaseLawJurisdiction`: adding a
 * jurisdiction to the adapter registry fails to compile until its reach is
 * declared, and a jurisdiction whose citations must not cross a border says so
 * by declaring an empty `alsoResolvesTo` rather than by being absent.
 *
 * What this file is deliberately NOT: a citation grammar. It says nothing
 * about how a docket, a neutral citation or a reporter reference is spelled;
 * that is `bareCitationKey`'s problem, and a jurisdiction whose citations are
 * not docket-shaped (UK `[2019] UKSC 15`, US `410 U.S. 113`) changes the key
 * function, not this policy.
 */

import {
  CASE_LAW_JURISDICTIONS,
  type CaseLawJurisdiction,
} from "@/api/lib/legal-search/ingestion-constants";

export type CitationResolutionJurisdictionPolicy = {
  /**
   * Jurisdictions besides its own whose decisions a citation from here may
   * resolve to. Supranational courts a jurisdiction is subject to, so that
   * membership is a property of the member state rather than of the court.
   *
   * Empty means national-only: the common case, and the safe one, because a
   * key that matches across a border is a coincidence far more often than a
   * citation.
   */
  alsoResolvesTo: readonly CaseLawJurisdiction[];
};

/**
 * EU membership is the member state's declaration, not the CJEU's. Austria,
 * Czechia, Poland and Slovakia are all member states, so a citation in any of
 * their decisions can name a Court of Justice judgment; a CJEU judgment citing
 * a bare national docket is not a pattern this corpus can honour, so `EU`
 * reaches nothing but itself.
 */
export const CITATION_RESOLUTION_JURISDICTION_POLICY = {
  AUT: { alsoResolvesTo: ["EU"] },
  CZE: { alsoResolvesTo: ["EU"] },
  EU: { alsoResolvesTo: [] },
  POL: { alsoResolvesTo: ["EU"] },
  SVK: { alsoResolvesTo: ["EU"] },
} as const satisfies Record<
  CaseLawJurisdiction,
  CitationResolutionJurisdictionPolicy
>;

/**
 * The jurisdictions a citation written in `jurisdiction` may resolve into,
 * own jurisdiction first. Derived rather than declared, so a policy cannot
 * accidentally omit the citing jurisdiction itself.
 */
export const resolvableJurisdictionsFrom = (
  jurisdiction: CaseLawJurisdiction,
): readonly CaseLawJurisdiction[] => [
  jurisdiction,
  ...CITATION_RESOLUTION_JURISDICTION_POLICY[jurisdiction].alsoResolvesTo,
];

/**
 * The policy as `(citing jurisdiction, allowed cited jurisdictions)` rows, for
 * the resolver's SQL to join against.
 *
 * The whole map goes into the statement rather than the citing row's own entry
 * because a batch spans jurisdictions: each row picks up its own reach by
 * joining on the citing decision's country. A citing jurisdiction absent from
 * this list therefore drops out of the batch entirely instead of resolving
 * against a default, which is what makes an undeclared jurisdiction visible as
 * unexamined work rather than as silent misses.
 */
export const citationResolutionPolicyRows = (): readonly {
  jurisdiction: CaseLawJurisdiction;
  resolvesTo: readonly CaseLawJurisdiction[];
}[] =>
  CASE_LAW_JURISDICTIONS.map((jurisdiction) => ({
    jurisdiction,
    resolvesTo: resolvableJurisdictionsFrom(jurisdiction),
  }));
