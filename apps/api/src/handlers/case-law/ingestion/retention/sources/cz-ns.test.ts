import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import {
  buildCzNsDecision,
  czNsAdapter,
} from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { RETENTION_TEXT_ABSENCE } from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import {
  validateAst,
  type ValidationResult,
} from "@/api/lib/legal-search/parsers/validate-ast";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { czNsFixture } from "@/api/tests/helpers/case-law-enrolled-fixtures";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import { czNsRetention } from "./cz-ns";

const UNID = "0123456789abcdef0123456789abcdef";

const projectionOf = async (sourceRaw: string) =>
  czNsRetention.type === "checked"
    ? await czNsRetention.project(sourceRaw)
    : panic("cz-ns is declared unparsed");

/** The oracle's verdict on the adapter's document against the projection. */
const retentionOf = async (
  decision: IngestionResult,
): Promise<ValidationResult> => {
  const ast = decision.documentAst;
  if (!hasUsableAst(ast)) {
    return panic("the adapter built no document");
  }
  const projection = await projectionOf(
    decision.sourceRaw ?? panic("the decision stores no raw"),
  );
  return projection.type === "source"
    ? validateAst(projection.source, ast.blocks, projection.options)
    : panic(`projection answered ${projection.type}`);
};

/** A decision the adapter builds from the two pages, served as given. */
const builtFrom = async (pages: {
  detail: string;
  print: string | null;
}): Promise<IngestionResult> => {
  globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes("/WebPrint/")) {
      return await Promise.resolve(new Response(pages.detail));
    }
    return await Promise.resolve(
      pages.print === null
        ? new Response("", { status: 404 })
        : new Response(pages.print),
    );
  });
  const built = await buildCzNsDecision({
    unid: UNID,
    caseNumber: "1 Cdo 1/2026",
  });
  return built.type === "built"
    ? built.decision
    : panic(`cz-ns did not build: ${built.type}`);
};

/** The print page the adapter's own tests serve for a decision. */
const MINIMAL_PRINT_PAGE = "<html><body><p>Rozhodnutí soudu.</p></body></html>";

describe("cz-ns retention against the print page the court served", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("the enrolled synthetic decision keeps its text", async () => {
    const result = await retentionOf(await czNsFixture().buildDecision());
    expect(result.stats.missingWords).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // Finding (parser text loss): the cz-ns parser walks only the body nodes
  // after `#box-table-a`, so a print page without that metadata table yields
  // an empty document and everything before the table is dropped. The
  // adapter tests' minimal print page builds no blocks at all, so the
  // pipeline's check is never reached for it. Not a projection fault: the
  // page's whole text is the paragraph the parser skipped.
  test.failing(
    "the adapter tests' minimal print page keeps its text",
    async () => {
      const result = await retentionOf(
        await builtFrom({
          detail: MINIMAL_PRINT_PAGE,
          print: MINIMAL_PRINT_PAGE,
        }),
      );
      expect(result.stats.missingWords).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );

  test("the metadata table is the record's metadata, not decision text", async () => {
    const decision = await czNsFixture().buildDecision();
    const projection = await projectionOf(decision.sourceRaw ?? "");
    if (projection.type !== "source") {
      panic(`expected projected text, got ${projection.type}`);
    }
    const sourceText =
      typeof projection.source === "string"
        ? projection.source
        : projection.source.paragraphs.join("\n");
    expect(sourceText).not.toContain("box-table-a");
  });

  test("a row stored before the envelope projects the same text", async () => {
    const decision = await czNsFixture().buildDecision();
    const parts =
      decodeSourceRawEnvelope(decision.sourceRaw ?? "") ??
      panic("the adapter wrote no envelope");
    const legacyRaw = JSON.stringify({
      webHtml: parts["detail"],
      printHtml: parts["print"],
    });
    const replay = await czNsAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(legacyRaw),
      contentType: "text/html",
      caseNumber: decision.caseNumber,
      sourceDocumentId: decision.sourceDocumentId ?? null,
      language: decision.language,
      court: decision.court,
      ecli: decision.ecli ?? null,
      decisionDate: decision.decisionDate ?? null,
      decisionType: decision.decisionType ?? null,
      sourceUrl: decision.sourceUrl ?? null,
      documentUrl: decision.documentUrl ?? null,
      metadata: decision.metadata,
    });
    if (replay?.type !== "parsed") {
      panic(`the legacy row did not replay: ${replay?.type ?? "missing"}`);
    }
    expect(replay.result.sourceRaw).toBe(legacyRaw);
    const result = await retentionOf(replay.result);
    expect(result.stats.missingWords).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("a decision the court served no print page for has no text", async () => {
    const decision = await builtFrom({
      detail: MINIMAL_PRINT_PAGE,
      print: null,
    });
    expect(await projectionOf(decision.sourceRaw ?? "")).toEqual({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED,
    });
  });

  test("a raw holding neither shape is reported unreadable", async () => {
    expect((await projectionOf("not a stored payload")).type).toBe(
      "unreadable",
    );
  });
});
