import { describe, expect, test } from "bun:test";

import { parseNativeImageProbeReport } from "@stll/ai-catalog";

import {
  isNativeImageFormatRejection,
  runNativeImageProbes,
} from "./ai-native-image-canary";

const fixture = async () =>
  Bun.file(
    new URL("fixtures/native-image-canary.heic", import.meta.url),
  ).bytes();

const probeOptions = {
  apiKey: "synthetic-test-key",
  provider: "google",
  modelIds: ["synthetic-model-a", "synthetic-model-b"],
  adapterVersion: "synthetic-adapter@1.0.0",
  sourceRevision: `${"a".repeat(40)}:${"b".repeat(64)}`,
  now: () => Date.UTC(2026, 8, 6),
} as const satisfies Omit<Parameters<typeof runNativeImageProbes>[0], "bytes">;

describe("native image capability evidence", () => {
  test("probes every model and MIME with the original HEIC bytes and records their provenance", async () => {
    const bytes = await fixture();
    expect(new TextDecoder().decode(bytes.subarray(4, 12))).toBe("ftypheic");
    const calls: string[] = [];
    const signal = new AbortController().signal;
    const records = await runNativeImageProbes({
      ...probeOptions,
      bytes,
      probe: async (options) => {
        expect(options.bytes).toBe(bytes);
        expect(options.apiKey).toBe(probeOptions.apiKey);
        expect(options.provider).toBe(probeOptions.provider);
        expect(options.signal).toBe(signal);
        calls.push(`${options.modelId}/${options.mimeType}`);
      },
      runProbe: async ({ run, timeoutMs }) => {
        expect(timeoutMs).toBeGreaterThan(0);
        await run(signal);
        return { attempts: 1, status: "passed" };
      },
    });
    const expected = probeOptions.modelIds.flatMap((modelId) => [
      `${modelId}/image/heic`,
      `${modelId}/image/heif`,
    ]);
    expect(calls.toSorted()).toEqual(expected.toSorted());
    expect(
      records
        .map(({ modelId, mimeType }) => `${modelId}/${mimeType}`)
        .toSorted(),
    ).toEqual(expected.toSorted());
    const fixtureSha256 = new Bun.CryptoHasher("sha256")
      .update(bytes)
      .digest("hex");
    for (const record of records) {
      expect(record).toMatchObject({
        status: "supported",
        provider: probeOptions.provider,
        checkedAt: "2026-09-06T00:00:00.000Z",
        adapterVersion: probeOptions.adapterVersion,
        sourceRevision: probeOptions.sourceRevision,
        fixtureSha256,
      });
    }
    expect(
      parseNativeImageProbeReport({ probeVersion: 1, records }).records,
    ).toEqual(records);
  });

  test.each([
    { message: "Unsupported MIME type image/heic" },
    { cause: { message: "HEIF is not supported" } },
    { error: { message: "Image format must be one of PNG, JPEG" } },
    {
      status: 400,
      message:
        "messages.0.content.0.image.source.base64.media_type: Input should be 'image/jpeg', 'image/png', 'image/gif' or 'image/webp'",
    },
  ])("records explicit format rejections as unsupported: %j", async (error) => {
    expect(isNativeImageFormatRejection(error)).toBe(true);
    const records = await runNativeImageProbes({
      ...probeOptions,
      bytes: await fixture(),
      runProbe: async () => ({
        attempts: 1,
        status: "failed",
        error,
        signal: new AbortController().signal,
      }),
    });
    expect(records.every(({ status }) => status === "unsupported")).toBe(true);
  });

  test.each([
    { message: "Request timed out" },
    { status: 429, message: "Rate limit exceeded" },
    { status: 401, message: "Invalid API key" },
    { status: 403, message: "Access denied" },
    { status: 400, message: "Invalid structured output schema" },
    { message: "Native image probe did not read the image" },
  ])(
    "keeps operational failures and unread images inconclusive: %j",
    async (error) => {
      expect(isNativeImageFormatRejection(error)).toBe(false);
      const records = await runNativeImageProbes({
        ...probeOptions,
        bytes: await fixture(),
        runProbe: async () => ({
          attempts: 1,
          status: "failed",
          error,
          signal: new AbortController().signal,
        }),
      });
      expect(records.every(({ status }) => status === "inconclusive")).toBe(
        true,
      );
    },
  );

  test.each([401, 403, 429, 500, 503])(
    "operational HTTP status %i takes precedence over a nested format rejection",
    async (status) => {
      const records = await runNativeImageProbes({
        ...probeOptions,
        bytes: await fixture(),
        runProbe: async () => ({
          attempts: 1,
          status: "failed",
          error: { status, cause: { message: "Unsupported MIME image/heic" } },
          signal: new AbortController().signal,
        }),
      });
      expect(records.every((record) => record.status === "inconclusive")).toBe(
        true,
      );
    },
  );

  test("an aborted attempt cannot establish unsupported format evidence", async () => {
    const records = await runNativeImageProbes({
      ...probeOptions,
      bytes: await fixture(),
      runProbe: async () => ({
        attempts: 1,
        status: "failed",
        error: { message: "Unsupported MIME image/heic" },
        signal: AbortSignal.abort(),
      }),
    });
    expect(records.every(({ status }) => status === "inconclusive")).toBe(true);
  });

  test.each([
    { message: "Unsupported MIME image/heic", cause: { status: 429 } },
    { message: "Unsupported MIME image/heic", error: { statusCode: 503 } },
  ])(
    "nested operational evidence takes precedence over a wrapper message: %j",
    async (error) => {
      expect(isNativeImageFormatRejection(error)).toBe(false);
      const records = await runNativeImageProbes({
        ...probeOptions,
        bytes: await fixture(),
        runProbe: async () => ({
          attempts: 1,
          status: "failed",
          error,
          signal: new AbortController().signal,
        }),
      });
      expect(records.every(({ status }) => status === "inconclusive")).toBe(
        true,
      );
    },
  );

  test("budget exhaustion retains an inconclusive record for every untested pair", async () => {
    let time = probeOptions.now();
    let attempts = 0;
    const records = await runNativeImageProbes({
      ...probeOptions,
      bytes: await fixture(),
      now: () => time,
      runProbe: async () => {
        attempts += 1;
        time += 24 * 60 * 60 * 1000;
        return { attempts: 1, status: "passed" };
      },
    });
    expect(attempts).toBe(1);
    expect(records.map(({ status }) => status)).toEqual([
      "supported",
      "inconclusive",
      "inconclusive",
      "inconclusive",
    ]);
    expect(
      records.map(({ modelId, mimeType }) => `${modelId}/${mimeType}`),
    ).toEqual(
      probeOptions.modelIds.flatMap((modelId) => [
        `${modelId}/image/heic`,
        `${modelId}/image/heif`,
      ]),
    );
  });
});
