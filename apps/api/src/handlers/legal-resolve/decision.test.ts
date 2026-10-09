import { describe, expect, test } from "bun:test";

import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { resolveDecision } from "@/api/handlers/legal-resolve/decision";
import { createSafeId } from "@/api/lib/branded-types";

const row = (caseNumber = "3 Afs 41/2008 - 98") =>
  ({
    id: createSafeId<"caseLawDecision">(),
    caseNumber,
    caseNumberType: "case-number",
    country: "CZE",
    court: "Nejvyšší správní soud",
    courtAbbreviation: "NSS",
    decisionDate: "2008-10-30",
    ecli: "ECLI:CZ:NSS:2008:3.AFS.41.2008.98",
    identifiers: [],
    language: "cs",
    languageAlternates: [],
    slug: "/case/example",
  }) satisfies DecisionIdentityRow;

const lookupRows = (rows: DecisionIdentityRow[]) => async () => rows;

describe("decision legal resolution", () => {
  test("returns every non-resolved envelope status", async () => {
    expect(await resolveDecision("CZE", "   ")).toEqual({
      status: "incomplete_identifier",
      missing: ["identifier"],
    });
    expect(await resolveDecision("FRA", "ECLI:FR:CCASS:2024:1")).toEqual({
      status: "country_unavailable",
    });
    expect(
      await resolveDecision("CZE", "ECLI:CZ:NSS:2008:3.AFS.41.2008.98", {
        lookup: lookupRows([]),
      }),
    ).toEqual({ status: "not_found", reason: "no_exact_identity" });
    expect(
      await resolveDecision("CZE", "3 Afs 41/2008 - 98", {
        lookup: lookupRows([row(), row()]),
      }),
    ).toMatchObject({ status: "ambiguous" });
  });

  test("returns readable blocks for an exact identity", async () => {
    const result = await resolveDecision("CZE", "3 Afs 41/2008 - 98", {
      lookup: lookupRows([row()]),
      read: async () => ({
        status: "read",
        textAccess: "readable",
        ast: { blocks: [{ type: "paragraph", children: [] }] },
      }),
    });
    expect(result).toMatchObject({
      status: "resolved",
      document: { blocks: [{ type: "paragraph", children: [] }] },
    });
  });

  test("withholds licensed text while retaining metadata", async () => {
    const result = await resolveDecision("CZE", "3 Afs 41/2008 - 98", {
      lookup: lookupRows([row()]),
      read: async () => null,
    });
    expect(result).toMatchObject({
      status: "resolved",
      document: {
        textWithheld: "licence",
        metadata: { court: expect.any(String) },
      },
    });
    if (result.status === "resolved") {
      expect(result.document).not.toHaveProperty("text");
      expect(result.document).not.toHaveProperty("blocks");
    }
  });

  test("never promotes docket prefixes or near misses to candidates", async () => {
    for (const identifier of ["3 Afs 41", "3 Afs 41/2008 - 99"]) {
      expect(
        await resolveDecision("CZE", identifier, {
          lookup: lookupRows([row()]),
        }),
      ).toEqual({ status: "not_found", reason: "no_exact_identity" });
    }
  });
});
