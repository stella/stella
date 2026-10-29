import { panic, Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";
import { sha256Hex } from "@stll/sha256/bun";

import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  STORED_RAW_REPARSE_REJECTION,
  StoredRawReadError,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  StoredRawReparseInput,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  CZ_UOHS_SYNTHETIC_LISTING,
  czUohsSyntheticPdf,
} from "@/api/handlers/case-law/ingestion/adapters/__fixtures__/cz-uohs.synthetic";
import {
  buildCzUohsDecision,
  czUohsAdapter,
  parseCzUohsListing,
} from "@/api/handlers/case-law/ingestion/adapters/cz-uohs";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const originalFetch = globalThis.fetch;
const reparse = czUohsAdapter.reparseStoredRaw ?? panic("ÚOHS replay required");
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const replayInput = (decision: IngestionResult) => {
  const objects = decision.sourceRawObjects ?? {};
  const refs = Object.fromEntries(
    Object.entries(objects).map(([part, object]) => [
      part,
      {
        location: part,
        sha256: sha256Hex(object.bytes),
        byteLength: object.bytes.byteLength,
        contentType: object.contentType,
      },
    ]),
  );
  return {
    raw: new TextEncoder().encode(
      encodeSourceRawEnvelope(
        decodeSourceRawEnvelope(decision.sourceRaw ?? "") ??
          panic("Missing test source envelope"),
        refs,
      ),
    ),
    contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
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
    readObject: async (key: string) => Result.ok(objects[key]?.bytes ?? null),
  } as const satisfies StoredRawReparseInput;
};

const rejectPublisherReads = () => {
  globalThis.fetch = asFetchMock(async () =>
    panic("Replay must not request the publisher"),
  );
};

describe("ÚOHS stored document replay", () => {
  test("stored envelope and documents reproduce ingestion including canonical document selection", async () => {
    const first =
      parseCzUohsListing(CZ_UOHS_SYNTHETIC_LISTING).at(0) ??
      panic("Missing test record");
    const record = {
      ...first,
      dokument: [
        { typ: "Digitální objekt", url: "https://example.test/untrusted.pdf" },
        { typ: "Digitální objekt", url: "https://uohs.gov.cz/first.pdf" },
        { typ: "Digitální objekt", url: "https://uohs.gov.cz/second.pdf" },
      ],
    };
    const invalid = new TextEncoder().encode("%PDF-unreadable-fixture");
    const valid = czUohsSyntheticPdf();
    globalThis.fetch = asFetchMock(
      async (input: string | URL | Request) =>
        new Response(String(input).endsWith("/first.pdf") ? invalid : valid),
    );
    const decision = await buildCzUohsDecision(record);
    expect(decision.documentUrl).toBe("https://uohs.gov.cz/second.pdf");
    expect(Object.keys(decision.sourceRawObjects ?? {})).toEqual([
      "document-1",
      "document-2",
    ]);
    const input = replayInput(decision);
    rejectPublisherReads();
    const replay = await reparse(input);
    expect(replay.type).toBe("parsed");
    if (replay.type !== "parsed") {
      return;
    }
    expect(replay.result).toEqual(decision);
    const again = await reparse(replayInput(replay.result));
    expect(again).toEqual(replay);
  });

  test("an envelope without document objects is metadata-only and never refetches", async () => {
    const record =
      parseCzUohsListing(CZ_UOHS_SYNTHETIC_LISTING).at(0) ??
      panic("Missing test record");
    globalThis.fetch = asFetchMock(
      async () => new Response(czUohsSyntheticPdf()),
    );
    const decision = await buildCzUohsDecision(record);
    const input = replayInput(decision);
    rejectPublisherReads();
    for (const raw of [
      input.raw,
      new TextEncoder().encode(decision.sourceRaw ?? ""),
    ]) {
      const replay = await reparse({
        ...input,
        raw,
        readObject: async () => Result.ok(null),
      });
      expect(replay).toMatchObject({
        type: "rejected",
        rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
        status: "metadata-only",
      });
    }
  });
});

test("stored read failures retain their typed rejection across the adapter callback boundary", async () => {
  const record =
    parseCzUohsListing(CZ_UOHS_SYNTHETIC_LISTING).at(0) ??
    panic("Missing test record");
  globalThis.fetch = asFetchMock(
    async () => new Response(czUohsSyntheticPdf()),
  );
  const decision = await buildCzUohsDecision(record);
  const error = new StoredRawReadError({
    message: "Object store unavailable",
    key: "fixture",
    cause: "fixture",
    permanent: false,
  });
  rejectPublisherReads();
  expect(
    await rejectionOf(
      Promise.resolve().then(() =>
        reparse({
          ...replayInput(decision),
          readObject: async () => Result.err(error),
        }),
      ),
    ),
  ).toBe(error);
});
