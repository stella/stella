import { panic, Result } from "better-result";
import { describe, expect, expectTypeOf, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import type { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
import {
  admitLawRead,
  type LawReadAdmission,
} from "@/api/handlers/legal-resolve/admission";
import { resolveDecision } from "@/api/handlers/legal-resolve/decision";
import { createSafeId } from "@/api/lib/branded-types";
import { buildCaseLawDecisionUrl } from "@/api/lib/legal-search/public-law-app-urls";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";

const organizationId =
  parseAuthProviderId<"organization">("organization") ??
  panic("Fixture organization id is invalid");
const admissionResult = await admitLawRead({
  organizationId,
  mayReadPublicLaw: async () => Result.ok(true),
  publicLawEnabled: () => true,
});
const admission = Result.isOk(admissionResult)
  ? admissionResult.value
  : panic("Fixture law read was not admitted");

test("requires a law-read admission at compile time", () => {
  type Options = Parameters<typeof resolveDecision>[0];
  expectTypeOf<Options["admission"]>().toEqualTypeOf<LawReadAdmission>();
  expectTypeOf<{
    country: string;
    identifier: string;
  }>().not.toExtend<Options>();
});

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

const licensedDecision: typeof readDecisionReaderSource = async () => {
  const readable = await readableDecision({
    decisionId: row().id,
    phase: "blocks",
    audience: "model",
  });
  if (readable?.status !== "read") {
    return panic("Fixture decision is not readable");
  }
  return { ...readable, textAccess: "withheld", ast: null };
};

describe("decision legal resolution", () => {
  test("returns every non-resolved envelope status", async () => {
    expect(
      await resolveDecision({ admission, country: "CZE", identifier: "   " }),
    ).toEqual({
      status: "incomplete_identifier",
      missing: ["identifier"],
    });
    expect(
      await resolveDecision({
        admission,
        country: "FRA",
        identifier: "ECLI:FR:CCASS:2024:1",
      }),
    ).toEqual({
      status: "country_unavailable",
    });
    expect(
      await resolveDecision({
        admission,
        country: "CZE",
        identifier: "ECLI:CZ:NSS:2008:3.AFS.41.2008.98",
        dependencies: { lookup: lookupRows([]) },
      }),
    ).toEqual({ status: "not_found", reason: "no_exact_identity" });
    expect(
      await resolveDecision({
        admission,
        country: "CZE",
        identifier: "3 Afs 41/2008 - 98",
        dependencies: { lookup: lookupRows([row(), row()]) },
      }),
    ).toMatchObject({
      status: "ambiguous",
      candidates: [
        { decisionId: expect.any(String), readerUrl: expect.any(String) },
        { decisionId: expect.any(String), readerUrl: expect.any(String) },
      ],
    });
  });

  test("returns readable blocks for an exact identity", async () => {
    const result = await resolveDecision({
      admission,
      country: "CZE",
      identifier: "3 Afs 41/2008 - 98",
      dependencies: { lookup: lookupRows([row()]), read: readableDecision },
    });
    expect(result).toMatchObject({
      status: "resolved",
      document: {
        kind: "decision",
        decisionId: expect.any(String),
        text: { status: "readable", blocks: decisionAst().blocks },
      },
    });
    if (result.status === "resolved" && result.document.kind === "decision") {
      expect(result.document.readerUrl).toBe(
        buildCaseLawDecisionUrl({
          caseNumber: row().caseNumber,
          country: row().country,
          court: row().court,
          decisionId: result.document.decisionId,
          language: row().language,
          languageAlternates: row().languageAlternates,
          slug: row().slug,
        }),
      );
    }
  });

  test("marks only licensed text as withheld", async () => {
    const result = await resolveDecision({
      admission,
      country: "CZE",
      identifier: "3 Afs 41/2008 - 98",
      dependencies: { lookup: lookupRows([row()]), read: licensedDecision },
    });
    expect(result).toMatchObject({
      status: "resolved",
      document: {
        kind: "decision",
        court: expect.any(String),
        text: { status: "withheld", reason: "licence" },
      },
    });
  });

  test("marks a missing read as unavailable, not licensed", async () => {
    const result = await resolveDecision({
      admission,
      country: "CZE",
      identifier: "3 Afs 41/2008 - 98",
      dependencies: { lookup: lookupRows([row()]), read: missingDecision },
    });
    expect(result).toMatchObject({
      status: "resolved",
      document: { kind: "decision", text: { status: "unavailable" } },
    });
  });

  test("never promotes docket prefixes or near misses to candidates", async () => {
    for (const identifier of ["3 Afs 41", "3 Afs 41/2008 - 99"]) {
      expect(
        await resolveDecision({
          admission,
          country: "CZE",
          identifier,
          dependencies: { lookup: lookupRows([row()]) },
        }),
      ).toEqual({ status: "not_found", reason: "no_exact_identity" });
    }
  });
});
