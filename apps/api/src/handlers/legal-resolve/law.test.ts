import { panic, Result } from "better-result";
import { describe, expect, expectTypeOf, test } from "bun:test";
import { status } from "elysia";

import {
  admitLawRead,
  type LawReadAdmission,
} from "@/api/handlers/legal-resolve/admission";
import {
  resolveCzechLaw,
  resolveLawCitation,
} from "@/api/handlers/legal-resolve/law";
import type { resolveStatuteExpression } from "@/api/handlers/legislation/by-eli";
import type { readProvisionPreviewHandler } from "@/api/handlers/legislation/provision-preview";
import {
  projectProvisionPreview,
  projectStatuteReader,
} from "@/api/handlers/legislation/reader-response";
import { createSafeId } from "@/api/lib/branded-types";
import { buildLegislationDocumentAppUrl } from "@/api/lib/legal-search/public-law-app-urls";
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
  type Options = Parameters<typeof resolveLawCitation>[0];
  expectTypeOf<Options["admission"]>().toEqualTypeOf<LawReadAdmission>();
  expectTypeOf<{
    country: string;
    input: { citation: string };
  }>().not.toExtend<Options>();
});

const documentId = createSafeId<"legislationDocument">();
const eli = "https://www.e-sbirka.cz/eli/cz/sb/2024/1";
const resolveExpression: typeof resolveStatuteExpression = async () => ({
  type: "expression",
  id: documentId,
});
const documentFor = (
  versionValidFrom: string | null,
  versionValidTo: string | null,
) =>
  projectStatuteReader({
    id: documentId,
    eli,
    slug: "act",
    title: "Act",
    country: "CZE",
    language: "cs",
    documentType: "act",
    status: "in_force",
    effectiveDate: null,
    versionValidFrom,
    versionValidTo,
    expressionKind: "consolidation",
    windowDisposition: "effective",
    windowDispositionBasis: null,
    sourceUrl: null,
    documentUrl: null,
    documentAst: null,
    fulltext: null,
    citationCaseCount: 0,
    allowsDerivedAi: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    sections: null,
  });
const preview = projectProvisionPreview({
  documentId,
  language: "cs",
  anchorId: "par_12a",
  citedAnchorId: null,
  headings: [],
  heading: null,
  blocks: [],
});
const dependencies = (
  anchor = "par_12a",
  versionValidFrom: string | null = null,
  versionValidTo: string | null = null,
) => ({
  resolveExpression,
  readDocument: async () => documentFor(versionValidFrom, versionValidTo),
  readPreview: (async (input) => {
    expect(input.anchor).toBe(anchor);
    return {
      ...preview,
      appUrl: buildLegislationDocumentAppUrl({
        country: "CZE",
        documentId,
        eli,
        slug: "act",
        version: versionValidFrom,
        anchor,
      }),
    };
  }) satisfies typeof readProvisionPreviewHandler,
});

describe("law citation resolution", () => {
  test("resolves current and outdated versions", async () => {
    const input = {
      collection: "sb",
      year: "2024",
      number: "1",
      section: "12 a",
    };
    expect(await resolveCzechLaw(input, dependencies())).toMatchObject({
      status: "resolved",
      document: {
        kind: "provision",
        section: "12a",
        inForce: { from: null, to: null },
        versionStatus: "current",
      },
    });
    expect(
      await resolveCzechLaw(
        { ...input, asOf: "2023-01-01" },
        {
          ...dependencies("par_12a", "2020-01-01", null),
          today: () => "2026-01-01",
        },
      ),
    ).toMatchObject({
      status: "resolved",
      document: { versionStatus: "current" },
    });
    expect(
      await resolveCzechLaw(
        { ...input, asOf: "2023-01-01" },
        {
          ...dependencies("par_12a", "2020-01-01", "2024-01-01"),
          today: () => "2026-01-01",
        },
      ),
    ).toMatchObject({
      status: "resolved",
      document: { versionStatus: "outdated" },
    });
  });

  test("returns the provision reader URL", async () => {
    const result = await resolveCzechLaw(
      { collection: "sb", year: "2024", number: "1", section: "12 a" },
      dependencies(),
    );
    expect(result).toMatchObject({
      status: "resolved",
      document: {
        readerUrl: buildLegislationDocumentAppUrl({
          country: "CZE",
          documentId,
          eli,
          slug: "act",
          version: null,
          anchor: "par_12a",
        }),
      },
    });
  });

  test("normalizes section spaces and letter suffixes", async () => {
    await resolveCzechLaw(
      { collection: "sb", year: "2024", number: "1", section: " 12 A " },
      dependencies(),
    );
  });

  test("uses only the supported Collection of Laws identifier", async () => {
    let resolveCount = 0;
    const checkedDependencies = {
      ...dependencies(),
      resolveExpression: (async (input) => {
        resolveCount += 1;
        expect(input.eli).toBe(eli);
        return { type: "expression", id: documentId };
      }) satisfies typeof resolveStatuteExpression,
    };

    expect(
      await resolveCzechLaw(
        { collection: "sb", year: "2024", number: "1", section: "12a" },
        checkedDependencies,
      ),
    ).toMatchObject({ status: "resolved" });
    expect(
      await resolveCzechLaw(
        {
          collection: "unknown",
          year: "2024",
          number: "1",
          section: "12a",
        },
        checkedDependencies,
      ),
    ).toEqual({ status: "not_found", reason: "unknown_document" });
    expect(resolveCount).toBe(1);
  });

  test("distinguishes unknown sections and documents", async () => {
    const input = {
      collection: "sb",
      year: "2024",
      number: "1",
      section: "12",
    };
    expect(
      await resolveCzechLaw(input, {
        ...dependencies("par_12"),
        readPreview: async () =>
          status(404, { message: "Provision not found" }),
      }),
    ).toEqual({ status: "not_found", reason: "unknown_section" });
    expect(
      await resolveCzechLaw(input, {
        ...dependencies("par_12"),
        resolveExpression: async () => ({ type: "unknown-work" }),
      }),
    ).toEqual({ status: "not_found", reason: "unknown_document" });
  });

  test("returns country unavailable outside Czechia", async () => {
    expect(
      await resolveLawCitation({
        admission,
        country: "DEU",
        input: { citation: "unknown" },
      }),
    ).toEqual({
      status: "country_unavailable",
    });
  });
});
