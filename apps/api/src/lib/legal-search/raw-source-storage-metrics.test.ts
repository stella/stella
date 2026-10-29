import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  openRawSourceWriteWindow,
  RAW_SOURCE_FAMILY,
  rawSourcePayloadKey,
  writeCaseLawRawPayload,
  writeRawSourcePayload,
  writeSourceBinary,
} from "@/api/lib/legal-search/raw-source-storage";
import {
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/source-raw-envelope";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { type FakeS3, startFakeS3 } from "@/api/tests/helpers/fake-s3";

const SOURCE = "fixture-source";
const DOCUMENT_ID = "fixture-document-not-a-metric-dimension";
const bytes = new TextEncoder().encode("%PDF-1.7 raw document bytes");
const envelope = encodeSourceRawEnvelope({ detail: "Žaloba 法律" });

const fileInput = () => ({
  family: RAW_SOURCE_FAMILY.CASE_LAW,
  sourceId: SOURCE,
  documentId: DOCUMENT_ID,
  bytes,
  contentType: "application/pdf",
  window: openRawSourceWriteWindow(),
});

const payloadInput = () => ({
  owner: {
    family: RAW_SOURCE_FAMILY.CASE_LAW,
    sourceId: SOURCE,
    documentId: DOCUMENT_ID,
  },
  window: openRawSourceWriteWindow(),
  data: envelope,
  contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  storedKey: null,
  storedContentType: null,
});

type MetricRecordOptions = {
  family: string;
  source: string;
  kind: "document" | "payload";
  byteLength: number;
};

const metricRecord = ({
  family,
  source,
  kind,
  byteLength,
}: MetricRecordOptions) => ({
  family,
  source,
  kind,
  RawSourceStoredBytes: byteLength,
  RawSourceStoredObjects: 1,
  _aws: {
    Timestamp: expect.any(Number),
    CloudWatchMetrics: [
      {
        Namespace: "Stella/Api",
        Dimensions: [["family", "source", "kind"]],
        Metrics: [
          { Name: "RawSourceStoredBytes", Unit: "Bytes" },
          { Name: "RawSourceStoredObjects", Unit: "Count" },
        ],
      },
    ],
  },
});

describe("raw storage metrics count successful object writes", () => {
  let fake: FakeS3;
  let lines: string[];

  beforeEach(() => {
    fake = startFakeS3();
    lines = [];
    setMetricLineSinkForTesting((line) => {
      lines.push(line);
    });
  });

  afterEach(() => {
    resetMetricLineSinkForTesting();
    fake.stop();
  });

  test("document and UTF-8 envelope bytes are attributed independently to each source and corpus family", async () => {
    const envelopeBytes = Buffer.byteLength(envelope);
    expect(envelopeBytes).toBeGreaterThan(envelope.length);
    const expected = [];
    for (const family of Object.values(RAW_SOURCE_FAMILY)) {
      for (const sourceId of [SOURCE, "another-fixture-source"]) {
        expect(
          Result.isOk(
            await writeSourceBinary({
              ...fileInput(),
              family,
              sourceId,
            }),
          ),
        ).toBe(true);
        const input = payloadInput();
        if (family === RAW_SOURCE_FAMILY.CASE_LAW) {
          expect(
            Result.isOk(
              await writeCaseLawRawPayload({
                ...input,
                owner: { family, sourceId, documentId: DOCUMENT_ID },
              }),
            ),
          ).toBe(true);
        } else {
          await writeRawSourcePayload({
            ...input,
            owner: { family, sourceId },
          });
        }
        expected.push(
          metricRecord({
            family,
            source: sourceId,
            kind: "document",
            byteLength: bytes.byteLength,
          }),
          metricRecord({
            family,
            source: sourceId,
            kind: "payload",
            byteLength: envelopeBytes,
          }),
        );
      }
    }
    expect(lines.map((line) => JSON.parse(line))).toEqual(expected);
    expect(fake.objects.size).toBe(expected.length);
  });

  test("conditional duplicates and a cached payload add no bytes or object counters", async () => {
    const file = fileInput();
    const payload = payloadInput();
    expect(Result.isOk(await writeSourceBinary(file))).toBe(true);
    expect(Result.isOk(await writeCaseLawRawPayload(payload))).toBe(true);
    expect(lines).toHaveLength(2);
    const firstMetrics = [...lines];
    expect(Result.isOk(await writeSourceBinary(file))).toBe(true);
    expect(Result.isOk(await writeCaseLawRawPayload(payload))).toBe(true);
    expect(fake.requests.filter(({ method }) => method === "PUT")).toHaveLength(
      4,
    );
    expect([...fake.versions.values()]).toEqual([1, 1]);
    expect(lines).toEqual(firstMetrics);
    expect(
      Result.isOk(
        await writeCaseLawRawPayload({
          ...payload,
          storedKey: rawSourcePayloadKey(payload),
          storedContentType: payload.contentType,
        }),
      ),
    ).toBe(true);
    expect(fake.requests.filter(({ method }) => method === "PUT")).toHaveLength(
      4,
    );
    expect(lines).toEqual(firstMetrics);
  });

  test("a successful content-type rewrite counts the bytes actually written", async () => {
    const payload = payloadInput();
    expect(Result.isOk(await writeCaseLawRawPayload(payload))).toBe(true);
    expect(
      Result.isOk(
        await writeCaseLawRawPayload({
          ...payload,
          storedKey: rawSourcePayloadKey(payload),
          storedContentType: payload.contentType,
          contentType: "application/json",
        }),
      ),
    ).toBe(true);
    expect([...fake.versions.values()]).toEqual([2]);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      metricRecord({
        family: RAW_SOURCE_FAMILY.CASE_LAW,
        source: SOURCE,
        kind: "payload",
        byteLength: Buffer.byteLength(envelope),
      }),
      metricRecord({
        family: RAW_SOURCE_FAMILY.CASE_LAW,
        source: SOURCE,
        kind: "payload",
        byteLength: Buffer.byteLength(envelope),
      }),
    ]);
  });

  test("failed document and envelope writes emit no stored counters", async () => {
    fake.failNext({
      method: "PUT",
      code: "AccessDenied",
      status: 403,
      times: 100,
    });
    const document = await Result.tryPromise({
      try: async () => await writeSourceBinary(fileInput()),
      catch: (cause) => cause,
    });
    const payload = await Result.tryPromise({
      try: async () => await writeCaseLawRawPayload(payloadInput()),
      catch: (cause) => cause,
    });
    expect(Result.isError(document)).toBe(true);
    expect(Result.isError(payload)).toBe(true);
    expect(
      fake.requests.filter(({ method }) => method === "PUT").length,
    ).toBeGreaterThan(0);
    expect(fake.objects.size).toBe(0);
    expect(lines).toEqual([]);
  });

  test("closed decision write windows emit no stored counters", async () => {
    const window = { closesAtMs: 0 };
    expect(
      Result.isError(await writeSourceBinary({ ...fileInput(), window })),
    ).toBe(true);
    expect(
      Result.isError(
        await writeCaseLawRawPayload({ ...payloadInput(), window }),
      ),
    ).toBe(true);
    expect(fake.requests).toEqual([]);
    expect(lines).toEqual([]);
  });
});
