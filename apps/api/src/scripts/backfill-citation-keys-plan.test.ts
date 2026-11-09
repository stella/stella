import { describe, expect, test } from "bun:test";

import { docketFamilyKeyOf } from "@stll/api-contract/decision-docket-reference";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { decisionDocketColumns } from "@/api/handlers/case-law/ingestion/pipeline/decision-docket-columns";
import { decisionKeysToWrite } from "@/api/scripts/backfill-citation-keys-plan";
import type { StoredDecisionKeys } from "@/api/scripts/backfill-citation-keys-plan";

const unkeyed = (
  storedReference: string,
  storedReferenceType: string = DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
): StoredDecisionKeys => ({
  storedReference,
  storedReferenceType,
  storedCitationKey: null,
  country: "CZE",
  storedDocketFamilyKey: null,
});

describe("decisionKeysToWrite", () => {
  test("keys an unkeyed row as its row writer would", () => {
    for (const caseNumber of ["6 Ads 21/2026", "4 As 50/2012 - 33"]) {
      const written = decisionDocketColumns({
        caseNumber,
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        country: "CZE",
      });
      expect(decisionKeysToWrite(unkeyed(caseNumber), "missing")).toEqual({
        citationKey: written.citationKey,
        docketFamilyKey: written.docketFamilyKey,
      });
    }
  });

  test("puts a row stored with its sheet in its bare docket's case file", () => {
    const family = docketFamilyKeyOf("4 As 50/2012", "CZE");
    expect(family).not.toBeNull();
    expect(
      decisionKeysToWrite(unkeyed("4 As 50/2012 - 33"), "missing")
        .docketFamilyKey,
    ).toBe(family);
  });

  test("fills a missing case-file key beside a citation key already stored", () => {
    const row = {
      ...unkeyed("6 Ads 21/2026"),
      storedCitationKey: "stored-key",
    };
    expect(decisionKeysToWrite(row, "missing")).toEqual({
      citationKey: "stored-key",
      docketFamilyKey: docketFamilyKeyOf("6 Ads 21/2026", "CZE"),
    });
  });

  test("a recanonicalization rewrites both keys from the docket", () => {
    const row = {
      ...unkeyed("6 Ads 21/2026"),
      storedCitationKey: "old-key",
      storedDocketFamilyKey: "old-family",
    };
    const written = decisionDocketColumns({
      caseNumber: "6 Ads 21/2026",
      caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      country: "CZE",
    });
    expect(decisionKeysToWrite(row, "stale")).toEqual({
      citationKey: written.citationKey,
      docketFamilyKey: written.docketFamilyKey,
    });
  });

  test("a reference that is not a docket belongs to no case file", () => {
    expect(
      decisionKeysToWrite(
        unkeyed(
          "123/2026 Sb. NSS",
          DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        ),
        "missing",
      ).docketFamilyKey,
    ).toBeNull();
  });
});
