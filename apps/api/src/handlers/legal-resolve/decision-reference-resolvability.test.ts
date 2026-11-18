/**
 * Every decision resolves by the references it displays.
 *
 * A search result shows a decision's case number, and its ECLI where it has
 * one; an agent copies either into resolve. A reference only one side reads
 * (a number the ingestion writes but no resolve grammar claims, a key the
 * reader computes differently from the writer) is a decision search can show
 * and resolve cannot find. So the invariant is checked from the registry,
 * over the decision every adapter's conformance fixture builds, on both sides
 * of the lookup:
 *
 * 1. the stored keys the resolver reads the reference under meet the keys
 *    ingestion writes for that decision (identifier rows or its own column);
 * 2. among the rows such a read returns, the resolver's identity filter
 *    keeps the decision.
 */

import { describe, expect, test } from "bun:test";

import { resolveDecisionIdentity } from "@stll/api-contract/decision-query-intent";
import { decisionReporterGrammarForJurisdiction } from "@stll/api-contract/decision-reporter-grammar";

import {
  decisionIdentityLocatorOf,
  decisionIdentityReadKeys,
} from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { decisionDocketColumns } from "@/api/handlers/case-law/ingestion/pipeline/decision-docket-columns";
import { plannedIdentifiers } from "@/api/handlers/case-law/ingestion/pipeline/decision-plan";
import { decisionResolveIntent } from "@/api/handlers/legal-resolve/decision-constraints";
import { decisionDocketGrammarForCountry } from "@/api/lib/legal-search/adapter-manifest";
import { parsePrimaryReferenceType } from "@/api/lib/legal-search/decision-primary-reference";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { CASE_LAW_CONFORMANCE_FIXTURES } from "@/api/tests/helpers/case-law-enrolled-fixtures";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";

const testFetchState = createTestFetch();

/** What the write stores for a decision, keyed as every reader keys it. */
const storedIdentityOf = (result: IngestionResult) => {
  const caseNumberType = parsePrimaryReferenceType(result.caseNumberType);
  const { identifierRows } = plannedIdentifiers(result, caseNumberType);
  const { citationKey } = decisionDocketColumns({
    caseNumber: result.caseNumber,
    caseNumberType,
    country: result.country,
  });
  return {
    citationKey,
    ecliFolded: result.ecli?.toUpperCase() ?? null,
    identifierRows,
    hit: {
      caseNumber: result.caseNumber,
      ecli: result.ecli ?? null,
      identifiers: identifierRows.map(({ type, value }) => ({ type, value })),
    },
  };
};

/** The resolver's read of an entry, as `resolveDecision` reads it. */
const resolverReadOf = (country: string, entry: string) => {
  const intent = decisionResolveIntent(entry, {
    grammar: decisionDocketGrammarForCountry(country),
    reporters: decisionReporterGrammarForJurisdiction(country),
  });
  return {
    intent,
    keys: decisionIdentityReadKeys({
      country,
      locator: decisionIdentityLocatorOf(intent),
    }),
  };
};

/** Why an entry does not reach its decision, or null when it does. */
const unresolvableReason = (result: IngestionResult, entry: string) => {
  const stored = storedIdentityOf(result);
  const { intent, keys } = resolverReadOf(result.country, entry);
  const meetsRows = keys.identifierRows.some((read) =>
    stored.identifierRows.some(
      (row) =>
        row.type === read.type && read.keys.includes(row.normalizedValue),
    ),
  );
  const own = keys.ownColumn;
  const meetsOwnColumn =
    own !== null &&
    (own.column === "citation-key"
      ? stored.citationKey !== null && own.keys.includes(stored.citationKey)
      : stored.ecliFolded !== null && own.keys.includes(stored.ecliFolded));
  if (!meetsRows && !meetsOwnColumn) {
    return `"${entry}" is read as ${intent.kind} under keys ${JSON.stringify(keys)}, and none is a key the write stores (${JSON.stringify({ citationKey: stored.citationKey, rows: stored.identifierRows })})`;
  }
  const resolution = resolveDecisionIdentity(intent, [stored.hit], {
    reporters: decisionReporterGrammarForJurisdiction(result.country),
  });
  return resolution.status === "unique" ||
    resolution.status === "incomplete_identifier"
    ? null
    : `"${entry}" reaches the row but resolves to ${resolution.status}`;
};

describe("every decision resolves by the references it displays", () => {
  for (const [key, fixture] of Object.entries(CASE_LAW_CONFORMANCE_FIXTURES)) {
    test(key, async () => {
      try {
        const built = await fixture().buildDecision();
        const result = plainTextIngestionResult(built);
        const entries = [
          result.caseNumber,
          ...(result.ecli === undefined ? [] : [result.ecli]),
        ];
        expect(
          entries
            .map((entry) => unresolvableReason(result, entry))
            .filter((reason) => reason !== null),
        ).toEqual([]);
      } finally {
        testFetchState.restore();
      }
    });
  }
});

describe("a reference no grammar claims", () => {
  const authorityDecision = {
    caseNumber: "ÚOHS-S0236/2016/KD",
    caseNumberType: "case-number",
    country: "CZE",
    identifiers: [
      { type: "authority-decision-number", value: "ÚOHS-S0236/2016/KD" },
      {
        type: "authority-decision-number",
        value: "ÚOHS-S0236/2016/KD-17418/2016/851/LŠt",
      },
    ],
  } as const;

  test("is read as the stored reference, in any letter case", () => {
    for (const entry of [
      "ÚOHS-S0236/2016/KD",
      "úohs-s0236/2016/kd",
      " ÚOHS-S0236/2016/KD-17418/2016/851/LŠt ",
    ]) {
      const { intent } = resolverReadOf("CZE", entry);
      expect(intent.kind).toBe("reference");
      expect(
        resolveDecisionIdentity(intent, [
          {
            caseNumber: authorityDecision.caseNumber,
            ecli: null,
            identifiers: authorityDecision.identifiers,
          },
        ]).status,
      ).toBe("unique");
    }
  });

  test("names several decisions sharing one file number as ambiguous, not one of them", () => {
    const { intent } = resolverReadOf("CZE", "ÚOHS-S0236/2016/KD");
    const sibling = (reference: string) => ({
      caseNumber: authorityDecision.caseNumber,
      ecli: null,
      identifiers: [{ type: "authority-decision-number", value: reference }],
    });
    expect(
      resolveDecisionIdentity(intent, [
        sibling("ÚOHS-S0236/2016/KD-1/2016/851/A"),
        sibling("ÚOHS-S0236/2016/KD-2/2016/851/A"),
      ]).status,
    ).toBe("ambiguous");
  });

  test("keeps a decision its lookup found for an equivalent spelling", () => {
    const { intent } = resolverReadOf("CZE", "SA 12345");
    expect(intent.kind).toBe("reference");
    expect(
      resolveDecisionIdentity(intent, [
        {
          caseNumber: "SA.12345",
          ecli: null,
          identifiers: [{ type: "commission-case-number", value: "SA.12345" }],
        },
      ]).status,
    ).toBe("unique");
  });

  test("leaves a docket a court grammar reads to that grammar", () => {
    expect(resolverReadOf("CZE", "29 Cdo 4084/2009").intent.kind).toBe(
      "docket",
    );
  });
});
