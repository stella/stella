import { describe, expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import type { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
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

const decisionAst = () =>
  ({
    version: 1,
    source: {
      system: "legal-resolve-test",
      documentId: "decision",
      webUrl: "",
      printUrl: "",
    },
    metadata: {
      caseNumber: "3 Afs 41/2008 - 98",
      ecli: "ECLI:CZ:NSS:2008:3.AFS.41.2008.98",
      court: "Nejvyšší správní soud",
      decisionDate: "2008-10-30",
      decisionType: null,
      keywords: [],
      statutes: [],
    },
    blocks: [
      {
        type: "paragraph",
        id: "paragraph-1",
        anchorId: "paragraph-1",
        plainText: "Text",
        inlines: [{ type: "text", text: "Text" }],
      },
    ],
  }) satisfies DocumentAst;

const readableDecision: typeof readDecisionReaderSource = async () => ({
  status: "read",
  decision: {
    id: row().id,
    caseNumber: row().caseNumber,
    caseNumberType: row().caseNumberType,
    courtAbbreviation: row().courtAbbreviation,
    courtTier: "supreme",
    court: row().court,
    country: row().country,
    decisionDate: row().decisionDate,
    ecli: row().ecli,
    language: row().language,
    languageAlternates: row().languageAlternates,
    slug: row().slug,
  },
  textAccess: "readable",
  ast: decisionAst(),
  citationAnchors: [],
  provisionAnchors: [],
  referenceNextCursor: null,
});

const missingDecision: typeof readDecisionReaderSource = async () => null;

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
      read: readableDecision,
    });
    expect(result).toMatchObject({
      status: "resolved",
      document: { blocks: decisionAst().blocks },
    });
  });

  test("withholds licensed text while retaining metadata", async () => {
    const result = await resolveDecision("CZE", "3 Afs 41/2008 - 98", {
      lookup: lookupRows([row()]),
      read: missingDecision,
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
