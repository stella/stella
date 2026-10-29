import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import {
  CZ_UOHS_SYNTHETIC_LISTING,
  czUohsSyntheticPdf,
} from "@/api/handlers/case-law/ingestion/adapters/__fixtures__/cz-uohs.synthetic";
import {
  buildCzUohsDecision as uncheckedBuildCzUohsDecision,
  parseCzUohsListing,
} from "@/api/handlers/case-law/ingestion/adapters/cz-uohs";
import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { czUohsFixture } from "@/api/tests/helpers/case-law-enrolled-fixtures";
import { guardParser } from "@/api/tests/helpers/parser-reader-guard";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import { czUohsRetention } from "./cz-uohs";

const buildCzUohsDecision = guardParser(uncheckedBuildCzUohsDecision);

const ADAPTER_FIXTURES = new URL(
  "../../adapters/__fixtures__/",
  import.meta.url,
);

const projectionOf = async (sourceRaw: string) =>
  czUohsRetention.type === "checked"
    ? await czUohsRetention.project(sourceRaw)
    : panic("cz-uohs is declared unparsed");

const records = () => parseCzUohsListing(CZ_UOHS_SYNTHETIC_LISTING);

/**
 * The decision text is only in the PDF, which the stored raw names as a
 * binary object and never holds, so no decision of this source can be
 * compared against `sourceRaw`. The projection says so per decision.
 */
describe("cz-uohs retention: the text lives in a separate document", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("the enrolled synthetic decision builds a document its raw cannot state", async () => {
    const decision = await czUohsFixture().buildDecision();
    expect(hasUsableAst(decision.documentAst)).toBe(true);
    expect(await projectionOf(decision.sourceRaw ?? "")).toEqual({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.SEPARATE_DOCUMENT,
    });
  });

  for (const fixture of [
    "cz-uohs-2026-R0137.pdf",
    "cz-uohs-2026-S0383.pdf",
  ] as const) {
    test(`a decision served as the recorded ${fixture} names it as a separate document`, async () => {
      const bytes = await Bun.file(new URL(fixture, ADAPTER_FIXTURES)).bytes();
      globalThis.fetch = asFetchMock(async () => new Response(bytes));
      const [record] = records();
      const decision = await buildCzUohsDecision(
        record ?? panic("the synthetic export lost its first record"),
      );
      expect(hasUsableAst(decision.documentAst)).toBe(true);
      expect(await projectionOf(decision.sourceRaw ?? "")).toEqual({
        type: "no-text",
        reason: RETENTION_TEXT_ABSENCE.SEPARATE_DOCUMENT,
      });
    });
  }

  test("a record the export lists without documents has no text", async () => {
    globalThis.fetch = asFetchMock(
      async () => new Response(czUohsSyntheticPdf()),
    );
    const record =
      records().find((candidate) => candidate.dokument.length === 0) ??
      panic("the synthetic export lists no record without documents");
    const decision = await buildCzUohsDecision(record);
    expect(await projectionOf(decision.sourceRaw ?? "")).toEqual({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED,
    });
  });

  test("a raw that is not this source's envelope is reported unreadable", async () => {
    expect(await projectionOf("{}")).toEqual({
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    });
    expect(
      await projectionOf(encodeSourceRawEnvelope({ provenance: "{}" })),
    ).toEqual({
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.MISSING_TEXT_PART,
    });
  });
});
