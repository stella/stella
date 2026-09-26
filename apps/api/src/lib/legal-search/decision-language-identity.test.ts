import { describe, expect, test } from "bun:test";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";

import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import {
  UNPERSISTABLE_DECISION_FIELDS,
  UnpersistableDecisionFieldError,
} from "@/api/lib/errors/tagged-errors";
import {
  DECISION_LANGUAGE_IDENTITY,
  decisionLanguageGroupKey,
  decisionLanguageIdentityOf,
} from "@/api/lib/legal-search/decision-language-identity";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";

/** The key every decision was grouped by before the policy existed. */
const historicalKey = ({
  caseNumber,
  ecli,
  sourceId,
}: {
  caseNumber: string;
  ecli: string | undefined;
  sourceId: string;
}) => ecli || `${sourceId}:${caseNumber}`;

const refusal = (run: () => unknown): unknown => {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
};

describe("decision language identity", () => {
  const cases = [
    { caseNumber: "21 Cdo 1234/2020", ecli: undefined },
    { caseNumber: "21 Cdo 1234/2020", ecli: "" },
    { caseNumber: "C-128/22", ecli: "ECLI:EU:C:2023:1" },
  ];

  test("keeps the historical key wherever a jurisdiction groups by ECLI or docket", () => {
    const docketJurisdictions = [...CASE_LAW_JURISDICTIONS, "XAA"].filter(
      (country) =>
        decisionLanguageIdentityOf(country) ===
        DECISION_LANGUAGE_IDENTITY.ECLI_OR_DOCKET,
    );
    // Every declared jurisdiction but the one keyed by document, and an
    // undeclared stored code.
    expect(docketJurisdictions).toEqual([
      "AUT",
      "CZE",
      "EU",
      "HUN",
      "POL",
      "SVK",
      "XAA",
    ]);
    for (const country of docketJurisdictions) {
      for (const fields of cases) {
        expect(
          decisionLanguageGroupKey({
            ...fields,
            country,
            sourceDocumentId: "document-1",
            sourceId: "source-1",
          }),
        ).toBe(historicalKey({ ...fields, sourceId: "source-1" }));
      }
    }
  });

  test("groups a jurisdiction keyed by document by that document alone", () => {
    for (const fields of cases) {
      expect(
        decisionLanguageGroupKey({
          ...fields,
          country: "USA",
          sourceDocumentId: "cluster-1",
          sourceId: "source-1",
        }),
      ).toBe("source-1:document:cluster-1");
    }
  });

  test("refuses a decision of such a jurisdiction without its document identity", () => {
    const decision = {
      caseNumber: "347 U.S. 483",
      court: "Supreme Court of the United States",
      country: "USA",
      language: "en",
      metadata: {},
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      rawHash: "raw-hash",
      documentAst: {},
    };
    expect(
      sanitizeResult({ ...decision, sourceDocumentId: "cluster-1" })
        .sourceDocumentId,
    ).toBe("cluster-1");
    const error = refusal(() => sanitizeResult(decision));
    expect(error).toBeInstanceOf(UnpersistableDecisionFieldError);
    expect(error).toMatchObject({
      field: UNPERSISTABLE_DECISION_FIELDS.SOURCE_DOCUMENT_ID,
    });
    // A docket-keyed jurisdiction still takes a result without one.
    expect(
      sanitizeResult({ ...decision, country: "CZE" }).sourceDocumentId,
    ).toBeUndefined();
  });
});
