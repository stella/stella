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
  DECISION_IDENTIFIER_TYPES,
  type DecisionIdentifierType,
  normalizeStructuredDecisionIdentifier,
} from "@stll/legal-ast/decision-identifier";

import {
  decisionIdentityLocatorOf,
  decisionIdentityReadKeys,
} from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { normalizeDecisionIdentifierValueIn } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { decisionDocketColumns } from "@/api/handlers/case-law/ingestion/pipeline/decision-docket-columns";
import { plannedIdentifiers } from "@/api/handlers/case-law/ingestion/pipeline/decision-plan";
import { decisionResolveIntent } from "@/api/lib/case-law/decision-reference-intent";
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
          ...storedIdentityOf(result).identifierRows.map(({ value }) => value),
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

/** A displayed value of every stored kind, including ones no grammar claims. */
const IDENTIFIER_EXAMPLES = {
  [DECISION_IDENTIFIER_TYPES.AUTHORITY_DECISION_NUMBER]: {
    country: "CZE",
    value: "ÚOHS-S0236/2016/KD-17418/2016/851/LŠt",
  },
  [DECISION_IDENTIFIER_TYPES.CASE_NUMBER]: {
    country: "CZE",
    value: "29 Cdo 4084/2009",
  },
  [DECISION_IDENTIFIER_TYPES.COMMISSION_CASE_NUMBER]: {
    country: "EU",
    value: "SA.12345",
  },
  [DECISION_IDENTIFIER_TYPES.ECLI]: {
    country: "CZE",
    value: "ECLI:CZ:NS:2020:29.CDO.4084.2009.1",
  },
  [DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION]: {
    country: "GBR",
    value: "[2024] CSIH 4",
  },
  [DECISION_IDENTIFIER_TYPES.REPORTER_CITATION]: {
    country: "CZE",
    value: "Rc 60/2015",
  },
} as const satisfies Record<
  DecisionIdentifierType,
  { country: string; value: string }
>;

describe("every stored identifier kind remains reachable", () => {
  for (const type of Object.values(DECISION_IDENTIFIER_TYPES)) {
    test(type, () => {
      const { country, value } = IDENTIFIER_EXAMPLES[type];
      const { intent, keys } = resolverReadOf(country, value);
      expect(keys.identifierRows).toContainEqual({
        type,
        keys: expect.arrayContaining([
          normalizeDecisionIdentifierValueIn(country, type, value),
        ]),
      });
      const resolution = resolveDecisionIdentity(
        intent,
        [
          {
            caseNumber: "unrelated primary reference",
            ecli: null,
            identifiers: [{ type, value }],
          },
        ],
        { reporters: decisionReporterGrammarForJurisdiction(country) },
      );
      expect(["unique", "incomplete_identifier"]).toContain(resolution.status);
      const reference = decisionIdentityReadKeys({
        country,
        locator: { kind: "reference", value },
      });
      expect(reference.identifierRows).toContainEqual({
        type,
        keys: [normalizeDecisionIdentifierValueIn(country, type, value)],
      });
    });
  }

  test("recognized collection citations read only typed reporter rows", () => {
    for (const entry of ["Rc 60/2015", "R 60/2014", "č. 3528/2017 Sb. NSS"]) {
      const { intent, keys } = resolverReadOf("CZE", entry);
      expect(intent.kind).toBe("reporter");
      expect(keys.ownColumn).toBeNull();
      expect(keys.identifierRows.map(({ type }) => type)).toEqual([
        DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      ]);
      for (const type of Object.values(DECISION_IDENTIFIER_TYPES)) {
        if (type === DECISION_IDENTIFIER_TYPES.REPORTER_CITATION) {
          continue;
        }
        expect(
          resolveDecisionIdentity(
            intent,
            [
              {
                caseNumber: entry,
                ecli: null,
                identifiers: [{ type, value: entry }],
              },
            ],
            { reporters: decisionReporterGrammarForJurisdiction("CZE") },
          ).status,
        ).toBe("none");
      }
    }
  });
});

describe("Constitutional Court reporter references", () => {
  const reported = {
    caseNumber: "Pl. ÚS 18/01",
    ecli: null,
    identifiers: [{ type: "reporter-citation", value: "N 53/26 SbNU 73" }],
  } as const;
  for (const entry of [
    "N 53/26 SbNU 73",
    "N 53/26 SbNU",
    "svazek 26, nález č. 53",
    "SbNU sv. 26 N 53",
  ]) {
    test(`retains one identity through parse, stored-key lookup and filtering: ${entry}`, () => {
      const { intent, keys } = resolverReadOf("CZE", entry);
      expect(intent.kind).toBe("reporter");
      expect(intent.value).toBe("SbNU sv. 26 N 53");
      expect(resolverReadOf("CZE", intent.value).intent).toEqual(intent);
      expect(keys.identifierRows).toContainEqual({
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        keys: [
          normalizeDecisionIdentifierValueIn(
            "CZE",
            DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
            reported.identifiers[0].value,
          ),
        ],
      });
      expect(
        resolveDecisionIdentity(intent, [reported], {
          reporters: decisionReporterGrammarForJurisdiction("CZE"),
        }).status,
      ).toBe("unique");
      for (const value of ["U 53/26 SbNU 73", "N 5/326 SbNU 73"]) {
        expect(
          resolveDecisionIdentity(
            intent,
            [
              {
                ...reported,
                identifiers: [{ type: "reporter-citation", value }],
              },
            ],
            { reporters: decisionReporterGrammarForJurisdiction("CZE") },
          ).status,
        ).toBe("none");
      }
      expect(
        resolveDecisionIdentity(
          intent,
          [
            {
              ...reported,
              identifiers: [{ type: "case-number", value: entry }],
            },
          ],
          { reporters: decisionReporterGrammarForJurisdiction("CZE") },
        ).status,
      ).toBe("none");
    });
  }
  test("does not claim a bare gazette number as a decision reporter", () => {
    expect(
      decisionReporterGrammarForJurisdiction("CZE")?.canonicalCitation(
        "234/2002 Sb.",
      ),
    ).toBeNull();
  });
});

describe("Czech collection keys across writer generations", () => {
  for (const { suffix, canonical } of [
    { suffix: "ob", canonical: "Rc 45/2012" },
    { suffix: "obč", canonical: "Rc 45/2012" },
    { suffix: "tr", canonical: "Rt 45/2012" },
  ]) {
    for (const marker of ["č", "c"]) {
      const value = `${marker}. 45/2012 Sb. rozh. ${suffix}.`;
      test(`reads both the canonical writer key and the actual legacy key: ${value}`, () => {
        const type = DECISION_IDENTIFIER_TYPES.REPORTER_CITATION;
        const writerKey = normalizeDecisionIdentifierValueIn(
          "CZE",
          type,
          value,
        );
        const legacyKey = normalizeStructuredDecisionIdentifier({
          type,
          value,
        });
        expect(writerKey).toBe(
          normalizeStructuredDecisionIdentifier({ type, value: canonical }),
        );
        expect(writerKey).not.toBe(legacyKey);
        for (const entry of [value, canonical]) {
          const { intent, keys } = resolverReadOf("CZE", entry);
          expect(intent.kind).toBe("reporter");
          expect(intent.value).toBe(canonical);
          expect(keys.identifierRows).toContainEqual({
            type,
            keys: expect.arrayContaining([writerKey, legacyKey]),
          });
          expect(
            resolveDecisionIdentity(
              intent,
              [
                {
                  caseNumber: "unrelated primary reference",
                  ecli: null,
                  identifiers: [{ type, value }],
                },
              ],
              { reporters: decisionReporterGrammarForJurisdiction("CZE") },
            ).status,
          ).toBe("unique");
        }
      });
    }
  }
  test("retains old ASCII NSS marker keys while the writer uses its canonical spelling", () => {
    const type = DECISION_IDENTIFIER_TYPES.REPORTER_CITATION;
    const value = "c. 3528/2017 Sb. NSS";
    const writerKey = normalizeDecisionIdentifierValueIn("CZE", type, value);
    const legacyKey = normalizeStructuredDecisionIdentifier({ type, value });
    expect(writerKey).not.toBe(legacyKey);
    const { keys } = resolverReadOf("CZE", "č. 3528/2017 Sb. NSS");
    expect(keys.identifierRows).toContainEqual({
      type,
      keys: expect.arrayContaining([writerKey, legacyKey]),
    });
  });
});
