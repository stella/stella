import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import { plSnAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-sn";
import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { plSnRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-sn";
import { readGzipJson } from "@/api/lib/gzip-json";
import type {
  IngestionResult,
  RawIngestionResult,
} from "@/api/lib/legal-search/ingestion-types";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const PAGE = new URL(
  "../../adapters/__fixtures__/pl-sn-page.json.gz",
  import.meta.url,
);

/** The recorded crawl's decision, as the adapter stored it. */
const recordedDecision = async (): Promise<IngestionResult> => {
  const record: unknown = await readGzipJson(PAGE);
  const page = isRecord(record) ? record["page"] : undefined;
  const decisions = isRecord(page) ? page["decisions"] : undefined;
  const [decision] = isUnknownArray(decisions) ? decisions : [];
  return isRawIngestionResult(decision)
    ? plainTextIngestionResult(decision)
    : panic("the recorded page holds no decision");
};

const isRawIngestionResult = (value: unknown): value is RawIngestionResult =>
  isRecord(value) &&
  typeof value["caseNumber"] === "string" &&
  typeof value["sourceRaw"] === "string";

/** The same envelope, rebuilt by the adapter's own replay. */
const rebuilt = async (decision: IngestionResult): Promise<IngestionResult> => {
  const outcome = await plSnAdapter.reparseStoredRaw?.({
    raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
    contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    caseNumber: decision.caseNumber,
    sourceDocumentId: decision.sourceDocumentId ?? null,
    language: decision.language,
    court: decision.court,
    ecli: null,
    decisionDate: decision.decisionDate ?? null,
    decisionType: decision.decisionType ?? null,
    sourceUrl: decision.sourceUrl ?? null,
    documentUrl: decision.documentUrl ?? null,
    metadata: decision.metadata,
  });
  return outcome?.type === "parsed"
    ? outcome.result
    : panic("the recorded envelope did not rebuild");
};

const project = async (sourceRaw: string) =>
  plSnRetention.type === "checked"
    ? await plSnRetention.project(sourceRaw)
    : panic("pl-sn is a checked source");

/** The envelope with its document answer replaced by `payload`. */
const withDocumentPayload = (sourceRaw: string, payload: unknown): string => {
  const parts =
    decodeSourceRawEnvelope(sourceRaw) ??
    panic("the decision stores no envelope");
  return encodeSourceRawEnvelope({
    ...parts,
    document: JSON.stringify({ data: [{ data: payload }] }),
  });
};

describe("pl-sn retention projection", () => {
  test("the recorded decision keeps the text of its PDF", async () => {
    const decision = await rebuilt(await recordedDecision());
    const ast = decision.documentAst;
    if (!hasUsableAst(ast)) {
      panic("the adapter built no document");
    }
    const projection = await project(
      decision.sourceRaw ?? panic("no sourceRaw"),
    );
    if (projection.type !== "source") {
      panic(`projection answered ${projection.type}`);
    }
    const result = validateAst(
      projection.source,
      ast.blocks,
      projection.options,
    );
    expect(
      result.ok,
      `retained ${result.stats.retainedPct.toFixed(1)}%, missing ${result.stats.missingWords.slice(0, 20).join(", ")}`,
    ).toBe(true);
  });

  test("a document that lost a paragraph reads as lost text", async () => {
    const decision = await rebuilt(await recordedDecision());
    const ast = decision.documentAst;
    if (!hasUsableAst(ast)) {
      panic("the adapter built no document");
    }
    const projection = await project(
      decision.sourceRaw ?? panic("no sourceRaw"),
    );
    if (projection.type !== "source") {
      panic(`projection answered ${projection.type}`);
    }
    const longest = ast.blocks
      .toSorted((left, right) => right.plainText.length - left.plainText.length)
      .at(0);
    expect(
      validateAst(
        projection.source,
        ast.blocks.filter((block) => block !== longest),
        projection.options,
      ).ok,
    ).toBe(false);
  });

  test("a decision the proxy served no document for states no text", async () => {
    const decision = await recordedDecision();
    const parts =
      decodeSourceRawEnvelope(decision.sourceRaw ?? "") ??
      panic("the decision stores no envelope");
    const { document: _document, ...withoutDocument } = parts;
    expect(await project(encodeSourceRawEnvelope(withoutDocument))).toEqual({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED,
    });
  });

  test("a document answer without a PDF states no text", async () => {
    const decision = await recordedDecision();
    expect(
      await project(withDocumentPayload(decision.sourceRaw ?? "", { raw: "" })),
    ).toEqual({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED,
    });
  });

  test("bytes no PDF opens from are an unreadable document", async () => {
    const decision = await recordedDecision();
    for (const raw of [btoa("not a pdf at all"), "%%% not base64 %%%"]) {
      expect(
        await project(withDocumentPayload(decision.sourceRaw ?? "", { raw })),
      ).toEqual({
        type: "unreadable",
        reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_DOCUMENT,
      });
    }
  });

  test("a payload that is no envelope is unreadable", async () => {
    expect(await project("{not json")).toEqual({
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    });
  });
});
