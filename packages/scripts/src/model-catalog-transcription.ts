/**
 * Transcription half of the nightly catalog check. The text-model listing
 * (`/api/v1/models`) never includes transcription models, so each OpenRouter
 * endpoint's transcription listing is read separately and compared with
 * `TRANSCRIPTION_MODELS`: a model an endpoint stopped serving, a price that
 * moved, an endpoint that now serves a model the catalog marks unavailable,
 * a model that lost its zero data retention endpoint, and a new
 * zero-retention model nobody has reviewed.
 */
import {
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
} from "@stll/ai-catalog/transcription";
import type { TranscriptionEndpoint } from "@stll/ai-catalog/transcription";

const LISTING_PATH = "/api/v1/models?output_modalities=transcription";

export const TRANSCRIPTION_LISTING_URLS = {
  global: `https://openrouter.ai${LISTING_PATH}`,
  eu: `https://eu.openrouter.ai${LISTING_PATH}`,
  us: `https://us.openrouter.ai${LISTING_PATH}`,
} as const satisfies Record<TranscriptionEndpoint, string>;

export const ZERO_RETENTION_ENDPOINTS_URL =
  "https://openrouter.ai/api/v1/endpoints/zdr";

/**
 * Zero-retention transcription models upstream that the catalog does not
 * offer, each with a dated reason. A model missing here and from the
 * catalog fails the check.
 */
export const REVIEWED_UNOFFERED_TRANSCRIPTION_MODELS: Readonly<
  Record<string, string>
> = {
  "assemblyai/universal-3-5-pro": "2026-11-16: superseded by Universal-3.6 Pro",
  "elevenlabs/scribe-v2-medical":
    "2026-11-16: medical vocabulary variant of Scribe v2",
  "fish-audio/transcribe-1": "2026-11-16: not yet evaluated for dictation",
  "fish-audio/transcribe-1-pro": "2026-11-16: not yet evaluated for dictation",
  "microsoft/mai-transcribe-1.5": "2026-11-16: superseded by MAI-Transcribe 2",
  "mistralai/voxtral-mini-3b-2507":
    "2026-11-16: superseded by Voxtral Mini Transcribe 3.0",
  "mistralai/voxtral-small-24b-2507-stt":
    "2026-11-16: superseded by Voxtral Small Transcribe 3.0",
  "moondream/parakeet-ultra": "2026-11-16: not yet evaluated for dictation",
  "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b":
    "2026-11-16: streaming model; dictation sends whole chunks",
  "nvidia/nemotron-3.5-transcribe":
    "2026-11-16: not yet evaluated for dictation",
  "qwen/qwen3-asr-0.6b": "2026-11-16: not yet evaluated for dictation",
  "qwen/qwen3-asr-1.7b": "2026-11-16: not yet evaluated for dictation",
};

/** Catalog prices the listing states in another unit, with a dated note. */
export const ACKNOWLEDGED_TRANSCRIPTION_PRICES: Readonly<
  Record<string, string>
> = {
  "microsoft/mai-transcribe-2":
    "2026-11-16: the listing states this model's price per hour of audio",
};

/** Relative difference below which a price is treated as unchanged. */
const PRICE_TOLERANCE = 0.005;

/** Model id → listed USD per second of audio. */
export type TranscriptionListing = ReadonlyMap<string, number>;

export type TranscriptionFinding = {
  kind: "missing" | "price" | "region" | "retention" | "new" | "unreachable";
  modelId: string;
  detail: string;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const listedData = (body: unknown): unknown[] | null => {
  const data = isObject(body) ? body["data"] : undefined;
  return Array.isArray(data) ? data : null;
};

/** A transcription listing, or `null` when the body is not one. */
export const parseTranscriptionListing = (
  body: unknown,
): TranscriptionListing | null => {
  const data = listedData(body);
  if (data === null) {
    return null;
  }
  const listing = new Map<string, number>();
  for (const item of data) {
    if (!isObject(item) || typeof item["id"] !== "string") {
      continue;
    }
    const pricing = item["pricing"];
    const prompt = isObject(pricing) ? pricing["prompt"] : undefined;
    const price = typeof prompt === "string" ? Number(prompt) : Number.NaN;
    listing.set(item["id"], price);
  }
  return listing;
};

/** Model ids with a zero data retention endpoint, or `null` when the body
 *  is not the endpoint list. */
export const parseZeroRetentionModels = (
  body: unknown,
): ReadonlySet<string> | null => {
  const data = listedData(body);
  if (data === null) {
    return null;
  }
  const models = new Set<string>();
  for (const item of data) {
    if (isObject(item) && typeof item["model_id"] === "string") {
      models.add(item["model_id"]);
    }
  }
  return models;
};

const ENDPOINTS = [
  "global",
  "eu",
  "us",
] as const satisfies readonly TranscriptionEndpoint[];

type CheckOptions = {
  /** The listings that were reachable, by endpoint. */
  listings: Partial<Record<TranscriptionEndpoint, TranscriptionListing>>;
  /** `null` when the zero-retention list was unreachable. */
  zeroRetention: ReadonlySet<string> | null;
};

export const checkTranscriptionCatalog = ({
  listings,
  zeroRetention,
}: CheckOptions): TranscriptionFinding[] => {
  const findings: TranscriptionFinding[] = [];
  for (const modelId of Object.keys(TRANSCRIPTION_MODELS)) {
    if (!isTranscriptionModelId(modelId)) {
      continue;
    }
    const model = TRANSCRIPTION_MODELS[modelId];
    const offered = ENDPOINTS.some(
      (endpoint) => model.residency[endpoint].status === "available",
    );
    if (offered && zeroRetention !== null && !zeroRetention.has(modelId)) {
      findings.push({
        kind: "retention",
        modelId,
        detail: "no zero data retention endpoint any more; stop offering it",
      });
    }
    for (const endpoint of ENDPOINTS) {
      const listing = listings[endpoint];
      if (listing === undefined) {
        continue;
      }
      const availability = model.residency[endpoint];
      const listed = listing.get(modelId);
      if (availability.status === "available") {
        if (listed === undefined) {
          findings.push({
            kind: "missing",
            modelId,
            detail: `the ${endpoint} endpoint no longer lists it`,
          });
          continue;
        }
        if (Object.hasOwn(ACKNOWLEDGED_TRANSCRIPTION_PRICES, modelId)) {
          continue;
        }
        const catalogPrice =
          availability.price.usdNumerator /
          availability.price.secondsDenominator;
        if (
          !Number.isFinite(listed) ||
          Math.abs(catalogPrice - listed) > listed * PRICE_TOLERANCE
        ) {
          findings.push({
            kind: "price",
            modelId,
            detail: `${endpoint} lists $${String(listed)}/s, the catalog bills $${catalogPrice.toPrecision(6)}/s`,
          });
        }
        continue;
      }
      if (listed !== undefined && zeroRetention?.has(modelId) === true) {
        findings.push({
          kind: "region",
          modelId,
          detail: `the ${endpoint} endpoint now serves it; the catalog marks it ${availability.status}`,
        });
      }
    }
  }
  if (zeroRetention !== null) {
    const listedAnywhere = new Set(
      Object.values(listings).flatMap((listing) => [...listing.keys()]),
    );
    for (const modelId of [...listedAnywhere].toSorted()) {
      if (
        zeroRetention.has(modelId) &&
        !isTranscriptionModelId(modelId) &&
        !Object.hasOwn(REVIEWED_UNOFFERED_TRANSCRIPTION_MODELS, modelId)
      ) {
        findings.push({
          kind: "new",
          modelId,
          detail: "a zero-retention transcription model; offer or review it",
        });
      }
    }
  }
  return findings;
};

type FetchJson = (
  url: string,
) => Promise<{ ok: true; body: unknown } | { ok: false; reason: string }>;

const loadListing = async (
  endpoint: TranscriptionEndpoint,
  fetchJson: FetchJson,
): Promise<readonly [TranscriptionEndpoint, TranscriptionListing] | null> => {
  const fetched = await fetchJson(TRANSCRIPTION_LISTING_URLS[endpoint]);
  const listing = fetched.ok ? parseTranscriptionListing(fetched.body) : null;
  if (listing === null) {
    console.warn(
      `  Transcription (${endpoint}): unreachable (${fetched.ok ? "unexpected body" : fetched.reason})`,
    );
    return null;
  }
  console.log(`  Transcription (${endpoint}): ${listing.size} models`);
  return [endpoint, listing];
};

/**
 * Reads every endpoint's listing and the zero-retention list, and checks
 * the catalog against whatever was reachable. With no listing, or without
 * the zero-retention list, the catalog goes unverified, which is itself a
 * finding: a silent pass would hide a model that lost zero retention.
 */
export const loadTranscriptionFindings = async (
  fetchJson: FetchJson,
): Promise<TranscriptionFinding[]> => {
  const loaded = await Promise.all(
    ENDPOINTS.map(async (endpoint) => await loadListing(endpoint, fetchJson)),
  );
  const listings = Object.fromEntries(loaded.filter((entry) => entry !== null));
  if (Object.keys(listings).length === 0) {
    return [
      {
        kind: "unreachable",
        modelId: TRANSCRIPTION_LISTING_URLS.global,
        detail: "no OpenRouter transcription listing was reachable",
      },
    ];
  }
  const retention = await fetchJson(ZERO_RETENTION_ENDPOINTS_URL);
  const zeroRetention = retention.ok
    ? parseZeroRetentionModels(retention.body)
    : null;
  const findings = checkTranscriptionCatalog({ listings, zeroRetention });
  return zeroRetention === null
    ? [
        ...findings,
        {
          kind: "unreachable",
          modelId: ZERO_RETENTION_ENDPOINTS_URL,
          detail: "the zero-retention endpoint list was unreachable",
        },
      ]
    : findings;
};

export const printTranscriptionFindings = (
  findings: readonly TranscriptionFinding[],
): void => {
  for (const { kind, modelId, detail } of findings) {
    console.error(
      `  ✗ [TRANSCRIPTION ${kind.toUpperCase()}] ${modelId} — ${detail}`,
    );
  }
};
