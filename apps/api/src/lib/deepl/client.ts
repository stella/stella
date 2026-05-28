/**
 * DeepL document-translation REST client.
 *
 * Wraps DeepL's three-call file flow:
 *   POST   /v2/document               → upload
 *   GET    /v2/document/{id}          → poll status
 *   POST   /v2/document/{id}/result   → download translated bytes
 *
 * The Pro tier uses api.deepl.com; the Free tier (key suffix
 * `:fx`) uses api-free.deepl.com. Both share the same payloads.
 *
 * Errors are typed (auth / quota / rate-limit / document /
 * upstream / timeout) so the calling handler can map them to
 * actionable HTTP responses.
 */

import * as v from "valibot";

import {
  DeepLAuthError,
  DeepLDocumentError,
  DeepLQuotaError,
  DeepLRateLimitError,
  DeepLTimeoutError,
  DeepLUpstreamError,
} from "@/api/lib/deepl/errors";

const PRO_BASE_URL = "https://api.deepl.com";
const FREE_BASE_URL = "https://api-free.deepl.com";

const FREE_KEY_SUFFIX = ":fx";

const UPLOAD_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 15_000;
const RESULT_TIMEOUT_MS = 120_000;

const POLL_INITIAL_DELAY_MS = 2000;
const POLL_MAX_DELAY_MS = 10_000;
const POLL_BACKOFF_FACTOR = 1.5;
const DEFAULT_POLL_BUDGET_MS = 300_000;

export const resolveDeepLBaseUrl = (apiKey: string): string =>
  apiKey.endsWith(FREE_KEY_SUFFIX) ? FREE_BASE_URL : PRO_BASE_URL;

/**
 * Mask a DeepL API key for safe display in settings UI. Exposes
 * the first 8 chars and preserves the `:fx` free-tier suffix so
 * an admin can tell two stored keys apart without leaking either.
 */
export const maskDeepLKey = (key: string): string => {
  const visible = key.slice(0, 8);
  const suffix = key.endsWith(FREE_KEY_SUFFIX) ? FREE_KEY_SUFFIX : "";
  return `${visible}${"*".repeat(16)}${suffix}`;
};

/** Mirrors DeepL's `Formality` API parameter. */
export type DeepLFormality =
  | "default"
  | "more"
  | "less"
  | "prefer_more"
  | "prefer_less";

export type TranslateDocumentInput = {
  apiKey: string;
  /** Source bytes — must be DOCX, PDF, PPTX, XLSX, TXT, HTML, or XLIFF. */
  file: Uint8Array | ArrayBuffer;
  fileName: string;
  mimeType: string;
  /** Alpha-2 language code (e.g. "DE", "FR"). DeepL is case-insensitive. */
  targetLang: string;
  /** Omit to let DeepL detect the source. */
  sourceLang?: string | undefined;
  /** Defaults to `prefer_more` — legal copy reads better in formal register. */
  formality?: DeepLFormality | undefined;
  /** Caller-supplied wall-clock budget for the whole poll loop. */
  pollBudgetMs?: number | undefined;
};

export type TranslateDocumentResult = {
  bytes: Uint8Array;
  billedCharacters: number | null;
};

type DocumentHandle = { documentId: string; documentKey: string };

type DocumentStatus = {
  documentId: string;
  status: "queued" | "translating" | "done" | "error";
  secondsRemaining: number | undefined;
  billedCharacters: number | undefined;
  errorMessage: string | undefined;
};

const uploadResponseSchema = v.object({
  document_id: v.string(),
  document_key: v.string(),
});

const statusResponseSchema = v.object({
  document_id: v.string(),
  status: v.picklist(["queued", "translating", "done", "error"]),
  seconds_remaining: v.optional(v.number()),
  billed_characters: v.optional(v.number()),
  error_message: v.optional(v.string()),
});

const languagesResponseSchema = v.array(
  v.object({
    language: v.string(),
    name: v.string(),
    supports_formality: v.boolean(),
  }),
);

const authHeader = (apiKey: string): Record<string, string> => ({
  Authorization: `DeepL-Auth-Key ${apiKey}`,
});

/**
 * DeepL returns errors as `{ "message": "..." }` JSON. Surface the
 * message when present; fall back to the truncated raw body for
 * non-JSON edges (HTML error pages from intermediaries, etc.).
 */
const extractDeepLMessage = (bodyText: string): string => {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      return parsed.message;
    }
  } catch {
    // Fall through to the raw body.
  }
  return bodyText.slice(0, 500);
};

/**
 * Map DeepL HTTP failures to typed errors. The `bodyText` is
 * DeepL's response body (often JSON with a `message` field) and
 * is preserved as `cause` for telemetry.
 */
const mapHttpError = (status: number, bodyText: string): never => {
  const detail = extractDeepLMessage(bodyText);

  if (status === 401 || status === 403) {
    throw new DeepLAuthError({
      message: "DeepL rejected the API key",
      cause: detail,
    });
  }

  if (status === 429) {
    throw new DeepLRateLimitError({
      message: "DeepL rate limit reached",
      cause: detail,
    });
  }

  // 456 = "Quota Exceeded" per DeepL docs.
  if (status === 456) {
    throw new DeepLQuotaError({
      message: "DeepL character quota exceeded",
      cause: detail,
    });
  }

  if (status === 400 || status === 413 || status === 415) {
    throw new DeepLDocumentError({
      message: `DeepL rejected the document (HTTP ${status})`,
      detail,
    });
  }

  throw new DeepLUpstreamError({
    message: `DeepL request failed (HTTP ${status})`,
    httpStatus: status,
    cause: detail,
  });
};

const uploadDocument = async (
  input: TranslateDocumentInput,
): Promise<DocumentHandle> => {
  const bytes =
    input.file instanceof Uint8Array ? input.file : new Uint8Array(input.file);
  const blob = new Blob([new Uint8Array(bytes)], { type: input.mimeType });

  const form = new FormData();
  form.append("target_lang", input.targetLang.toUpperCase());
  if (input.sourceLang) {
    form.append("source_lang", input.sourceLang.toUpperCase());
  }
  form.append("formality", input.formality ?? "prefer_more");
  form.append("file", blob, input.fileName);

  const response = await fetch(
    `${resolveDeepLBaseUrl(input.apiKey)}/v2/document`,
    {
      method: "POST",
      headers: authHeader(input.apiKey),
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    mapHttpError(response.status, await response.text());
  }

  const json = v.parse(uploadResponseSchema, await response.json());
  return { documentId: json.document_id, documentKey: json.document_key };
};

const fetchStatus = async (
  apiKey: string,
  handle: DocumentHandle,
): Promise<DocumentStatus> => {
  const body = new URLSearchParams({ document_key: handle.documentKey });
  const response = await fetch(
    `${resolveDeepLBaseUrl(apiKey)}/v2/document/${handle.documentId}`,
    {
      method: "POST",
      headers: {
        ...authHeader(apiKey),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    mapHttpError(response.status, await response.text());
  }

  const json = v.parse(statusResponseSchema, await response.json());

  return {
    documentId: json.document_id,
    status: json.status,
    secondsRemaining: json.seconds_remaining,
    billedCharacters: json.billed_characters,
    errorMessage: json.error_message,
  };
};

const downloadResult = async (
  apiKey: string,
  handle: DocumentHandle,
): Promise<Uint8Array> => {
  const body = new URLSearchParams({ document_key: handle.documentKey });
  const response = await fetch(
    `${resolveDeepLBaseUrl(apiKey)}/v2/document/${handle.documentId}/result`,
    {
      method: "POST",
      headers: {
        ...authHeader(apiKey),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(RESULT_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    mapHttpError(response.status, await response.text());
  }

  return new Uint8Array(await response.arrayBuffer());
};

const delay = async (ms: number) => await Bun.sleep(ms);

/**
 * Translate a document via DeepL. Uploads, polls until the job
 * is `done` (or `error`), then downloads the translated bytes.
 * Throws one of the `DeepL*Error` tagged classes from
 * `./errors` on any failure path.
 */
export const translateDocument = async (
  input: TranslateDocumentInput,
): Promise<TranslateDocumentResult> => {
  const handle = await uploadDocument(input);

  const budget = input.pollBudgetMs ?? DEFAULT_POLL_BUDGET_MS;
  const startedAt = Date.now();
  let pollDelay = POLL_INITIAL_DELAY_MS;

  while (true) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > budget) {
      throw new DeepLTimeoutError({
        message: "DeepL did not finish within the allotted time",
        documentId: handle.documentId,
        elapsedMs: elapsed,
      });
    }

    await delay(pollDelay);
    pollDelay = Math.min(
      Math.round(pollDelay * POLL_BACKOFF_FACTOR),
      POLL_MAX_DELAY_MS,
    );

    const status = await fetchStatus(input.apiKey, handle);

    if (status.status === "error") {
      throw new DeepLDocumentError({
        message: "DeepL failed to translate the document",
        detail: status.errorMessage,
      });
    }

    if (status.status === "done") {
      const bytes = await downloadResult(input.apiKey, handle);
      return {
        bytes,
        billedCharacters: status.billedCharacters ?? null,
      };
    }
  }
};

/** List of supported target languages, used for the UI dropdown. */
export const fetchTargetLanguages = async (
  apiKey: string,
): Promise<{ code: string; name: string; supportsFormality: boolean }[]> => {
  const response = await fetch(
    `${resolveDeepLBaseUrl(apiKey)}/v2/languages?type=target`,
    {
      headers: authHeader(apiKey),
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    mapHttpError(response.status, await response.text());
  }

  const json = v.parse(languagesResponseSchema, await response.json());

  return json.map((lang) => ({
    code: lang.language,
    name: lang.name,
    supportsFormality: lang.supports_formality,
  }));
};
