import { describe, expect, test } from "bun:test";
import { status } from "elysia";

import {
  resolveCzechLaw,
  resolveLawCitation,
} from "@/api/handlers/legal-resolve/law";
import type { resolveStatuteExpression } from "@/api/handlers/legislation/by-eli";
import type { readPublicLegislationHandler } from "@/api/handlers/legislation/get";
import type { readProvisionPreviewHandler } from "@/api/handlers/legislation/provision-preview";
import {
  projectProvisionPreview,
  projectStatuteReader,
} from "@/api/handlers/legislation/reader-response";
import { createSafeId } from "@/api/lib/branded-types";

const documentId = createSafeId<"legislationDocument">();
const resolveExpression: typeof resolveStatuteExpression = async () => ({
  type: "expression",
  id: documentId,
});
const readDocument: typeof readPublicLegislationHandler = async () =>
  projectStatuteReader({
    id: documentId,
    eli: "eli",
    slug: "act",
    title: "Act",
    country: "CZE",
    language: "cs",
    documentType: "act",
    status: "in_force",
    effectiveDate: null,
    versionValidFrom: null,
    versionValidTo: null,
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
const dependencies = (anchor = "par_12a") => ({
  resolveExpression,
  readDocument,
  readPreview: (async (input) => {
    expect(input.anchor).toBe(anchor);
    return { ...preview, appUrl: "/law/example" };
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
      document: { metadata: { inForce: true, versionStatus: "current" } },
    });
    expect(
      await resolveCzechLaw({ ...input, asOf: "2023-01-01" }, dependencies()),
    ).toMatchObject({
      status: "resolved",
      document: { metadata: { inForce: false, versionStatus: "outdated" } },
    });
  });

  test("normalizes section spaces and letter suffixes", async () => {
    await resolveCzechLaw(
      { collection: "sb", year: "2024", number: "1", section: " 12 A " },
      dependencies(),
    );
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
    expect(await resolveLawCitation("DEU", { citation: "unknown" })).toEqual({
      status: "country_unavailable",
    });
  });
});
