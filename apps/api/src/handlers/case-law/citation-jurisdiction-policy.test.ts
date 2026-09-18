import { expect, test } from "bun:test";

import {
  CASE_LAW_JURISDICTIONS,
  type CaseLawJurisdiction,
} from "@stll/api-contract/case-law-jurisdictions";

import {
  CITATION_RESOLUTION_JURISDICTION_POLICY,
  citationResolutionPolicyRows,
  resolvableJurisdictionsFrom,
} from "@/api/handlers/case-law/citation-jurisdiction-policy";
import { listAdapters } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";

/**
 * The policy map is total over `CaseLawJurisdiction` by construction, so a
 * jurisdiction cannot be added to that union without declaring what its
 * citations may reach. What the compiler cannot see is the other direction:
 * the union is only the source of truth while it still describes the sources
 * that actually run. A registry that grows a jurisdiction the list does not
 * hold, or a list that keeps one no registered source publishes for, is the
 * drift these two assertions exist to catch — declared set against exercised
 * set, both ways.
 */

test("every registered source publishes for a declared jurisdiction", () => {
  const registered = new Set(listAdapters().map(({ country }) => country));
  const declared = new Set<string>(CASE_LAW_JURISDICTIONS);
  expect([...registered].filter((country) => !declared.has(country))).toEqual(
    [],
  );
});

/**
 * Jurisdictions declared before the source that will publish for them.
 *
 * The union is what forces the per-jurisdiction decisions (index group,
 * morphology language, docket grammar, court weights, citation reach) to be
 * authored, and those decisions have to exist before an adapter can write a
 * row anything reads correctly. So a jurisdiction is admitted here for the
 * window between its declaration and its adapter, and the entry is deleted in
 * the change that registers that adapter. An entry is a named, reviewable
 * exception; its absence is what keeps the assertion below a drift guard.
 */
const DECLARED_AHEAD_OF_A_SOURCE: readonly CaseLawJurisdiction[] = ["HUN"];

test("a jurisdiction is only excused a source while it is named here", () => {
  // A stale exception would silently excuse a jurisdiction whose source has
  // since landed, or one no longer declared at all.
  const registered = new Set<string>(
    listAdapters().map(({ country }) => country),
  );
  for (const jurisdiction of DECLARED_AHEAD_OF_A_SOURCE) {
    expect([jurisdiction, registered.has(jurisdiction)]).toEqual([
      jurisdiction,
      false,
    ]);
    expect(CASE_LAW_JURISDICTIONS).toContain(jurisdiction);
  }
});

test("every declared jurisdiction has a registered source", () => {
  const registered = new Set<string>(
    listAdapters().map(({ country }) => country),
  );
  expect(
    CASE_LAW_JURISDICTIONS.filter(
      (jurisdiction) =>
        !registered.has(jurisdiction) &&
        !DECLARED_AHEAD_OF_A_SOURCE.includes(jurisdiction),
    ),
  ).toEqual([]);
});

test("every declared jurisdiction resolves into its own corpus", () => {
  // Derived rather than declared, so a policy cannot omit it by accident: a
  // jurisdiction that could not reach its own decisions would resolve nothing.
  for (const jurisdiction of CASE_LAW_JURISDICTIONS) {
    expect(resolvableJurisdictionsFrom(jurisdiction)).toContain(jurisdiction);
  }
});

test("a jurisdiction never declares itself as its own supranational reach", () => {
  for (const jurisdiction of CASE_LAW_JURISDICTIONS) {
    expect(
      CITATION_RESOLUTION_JURISDICTION_POLICY[jurisdiction].alsoResolvesTo,
    ).not.toContain(jurisdiction);
  }
});

test("the declared cross-jurisdiction reach is exact", () => {
  expect(CITATION_RESOLUTION_JURISDICTION_POLICY).toEqual({
    AUT: { alsoResolvesTo: ["EU"] },
    CZE: { alsoResolvesTo: ["EU"] },
    EU: { alsoResolvesTo: [] },
    HUN: { alsoResolvesTo: ["EU"] },
    POL: { alsoResolvesTo: ["EU"] },
    SVK: { alsoResolvesTo: ["EU"] },
  });
});

test("the SQL policy rows cover exactly the declared jurisdictions", () => {
  // The resolver joins a batch row to its reach on this list. A jurisdiction
  // missing from it is not resolved against a default; it drops out of the
  // batch, so the omission would show up as unexamined work rather than as
  // wrong edges. The assertion keeps it from showing up at all.
  expect(
    citationResolutionPolicyRows()
      .map(({ jurisdiction }) => jurisdiction)
      .toSorted(),
  ).toEqual([...CASE_LAW_JURISDICTIONS].toSorted());
});
