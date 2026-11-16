import { expect, test } from "bun:test";

import {
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
} from "@stll/ai-catalog/transcription";
import type { TranscriptionEndpoint } from "@stll/ai-catalog/transcription";

import {
  ACKNOWLEDGED_TRANSCRIPTION_PRICES,
  checkTranscriptionCatalog,
  loadTranscriptionFindings,
  parseTranscriptionListing,
  parseZeroRetentionModels,
  REVIEWED_UNOFFERED_TRANSCRIPTION_MODELS,
  TRANSCRIPTION_LISTING_URLS,
  ZERO_RETENTION_ENDPOINTS_URL,
} from "./model-catalog-transcription";

const ENDPOINTS = ["global", "eu", "us"] as const;
const OFFERED = Object.keys(TRANSCRIPTION_MODELS).filter(
  isTranscriptionModelId,
);

/** Each endpoint's listing exactly as the catalog describes it. */
const matchingListing = (endpoint: TranscriptionEndpoint) =>
  new Map<string, number>(
    OFFERED.flatMap((modelId) => {
      const availability = TRANSCRIPTION_MODELS[modelId].residency[endpoint];
      return availability.status === "available"
        ? [
            [
              modelId,
              availability.price.usdNumerator /
                availability.price.secondsDenominator,
            ] as const,
          ]
        : [];
    }),
  );

const matchingListings = () => ({
  global: matchingListing("global"),
  eu: matchingListing("eu"),
  us: matchingListing("us"),
});

const zeroRetentionOfOffered = () =>
  new Set<string>(
    OFFERED.filter((modelId) =>
      ENDPOINTS.some(
        (endpoint) =>
          TRANSCRIPTION_MODELS[modelId].residency[endpoint].status ===
          "available",
      ),
    ),
  );

test("listings that match the catalog raise nothing", () => {
  expect(
    checkTranscriptionCatalog({
      listings: matchingListings(),
      zeroRetention: zeroRetentionOfOffered(),
    }),
  ).toEqual([]);
});

test("a dropped model, a moved price, a new region, lost retention and an unreviewed model are each raised", () => {
  const listings = matchingListings();
  listings.eu.delete("mistralai/voxtral-mini-transcribe");
  listings.global.set("google/chirp-3", 0.001);
  listings.us.set("nvidia/parakeet-tdt-0.6b-v3", 0.00002);
  listings.global.set("example/new-transcribe", 0.00001);
  listings.global.set("qwen/qwen3-asr-1.7b", 0.0000075);
  const zeroRetention = new Set(zeroRetentionOfOffered());
  zeroRetention.delete("deepgram/nova-3");
  zeroRetention.add("example/new-transcribe");
  zeroRetention.add("qwen/qwen3-asr-1.7b");
  const findings = checkTranscriptionCatalog({ listings, zeroRetention });
  expect(findings.map(({ kind, modelId }) => [kind, modelId])).toEqual([
    ["region", "nvidia/parakeet-tdt-0.6b-v3"],
    ["price", "google/chirp-3"],
    ["retention", "deepgram/nova-3"],
    ["missing", "mistralai/voxtral-mini-transcribe"],
    ["new", "example/new-transcribe"],
  ]);
});

test("a model without a zero-retention endpoint is never proposed", () => {
  const listings = matchingListings();
  listings.global.set("openai/gpt-transcribe", 0.000075);
  listings.global.set("example/retaining-transcribe", 0.00001);
  expect(
    checkTranscriptionCatalog({
      listings,
      zeroRetention: zeroRetentionOfOffered(),
    }),
  ).toEqual([]);
});

test("only reachable listings are compared", () => {
  expect(
    checkTranscriptionCatalog({
      listings: { global: new Map() },
      zeroRetention: null,
    }).every(({ modelId }) =>
      isTranscriptionModelId(modelId)
        ? TRANSCRIPTION_MODELS[modelId].residency.global.status === "available"
        : false,
    ),
  ).toBe(true);
  expect(
    checkTranscriptionCatalog({ listings: {}, zeroRetention: null }),
  ).toEqual([]);
});

test("reviewed and acknowledged ids name no offered model", () => {
  for (const modelId of Object.keys(REVIEWED_UNOFFERED_TRANSCRIPTION_MODELS)) {
    expect(isTranscriptionModelId(modelId)).toBe(false);
  }
  for (const [modelId, note] of [
    ...Object.entries(REVIEWED_UNOFFERED_TRANSCRIPTION_MODELS),
    ...Object.entries(ACKNOWLEDGED_TRANSCRIPTION_PRICES),
  ]) {
    expect(note).toMatch(/^\d{4}-\d{2}-\d{2}: /u);
    expect(modelId).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/u);
  }
  for (const modelId of Object.keys(ACKNOWLEDGED_TRANSCRIPTION_PRICES)) {
    expect(isTranscriptionModelId(modelId)).toBe(true);
  }
});

test("listing bodies parse to prices per second and the retention list to model ids", () => {
  expect(
    parseTranscriptionListing({
      data: [
        { id: "google/chirp-3", pricing: { prompt: "0.000266666666667" } },
        { id: "broken" },
        "ignored",
      ],
    }),
  ).toEqual(
    new Map([
      ["google/chirp-3", 0.000266666666667],
      ["broken", Number.NaN],
    ]),
  );
  expect(parseTranscriptionListing({ models: [] })).toBeNull();
  expect(
    parseZeroRetentionModels({
      data: [{ model_id: "google/chirp-3" }, { name: "no id" }],
    }),
  ).toEqual(new Set(["google/chirp-3"]));
  expect(parseZeroRetentionModels(null)).toBeNull();
});

test("an unreachable source fails the check instead of passing it", async () => {
  const unreachable = await loadTranscriptionFindings(async () => ({
    ok: false,
    reason: "timeout",
  }));
  expect(unreachable.map(({ kind, modelId }) => [kind, modelId])).toEqual([
    ["unreachable", TRANSCRIPTION_LISTING_URLS.global],
  ]);

  const listings = matchingListings();
  const withoutRetention = await loadTranscriptionFindings(async (url) => {
    const endpoint = (["global", "eu", "us"] as const).find(
      (candidate) => TRANSCRIPTION_LISTING_URLS[candidate] === url,
    );
    return endpoint === undefined
      ? { ok: false, reason: "timeout" }
      : {
          ok: true,
          body: {
            data: [...listings[endpoint]].map(([id, price]) => ({
              id,
              pricing: { prompt: String(price) },
            })),
          },
        };
  });
  expect(withoutRetention.map(({ kind, modelId }) => [kind, modelId])).toEqual([
    ["unreachable", ZERO_RETENTION_ENDPOINTS_URL],
  ]);
});
