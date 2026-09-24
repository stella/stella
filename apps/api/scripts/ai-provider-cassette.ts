import { TaggedError } from "better-result";
import * as v from "valibot";

import { stableStringify } from "@stll/stable-stringify";
import type { StableStringifyInput } from "@stll/stable-stringify";

const CASSETTE_VERSION = 1;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_HEADER_NAMES = [
  "content-type",
  "anthropic-version",
  "openai-version",
] as const;
const AUTH_QUERY_KEYS = new Set(["access_token", "api-key", "api_key", "key"]);
const JSON_CONTENT_TYPES = new Set([
  "application/json",
  "application/problem+json",
]);

const headersSchema = v.record(v.string(), v.string());
const requestSchema = v.strictObject({
  method: v.literal("POST"),
  url: v.string(),
  headers: headersSchema,
  bodySha256: v.pipe(v.string(), v.regex(/^[a-f\d]{64}$/u)),
});
const responseSchema = v.strictObject({
  status: v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599)),
  contentType: v.string(),
  body: v.string(),
});
const entrySchema = v.strictObject({
  request: requestSchema,
  response: responseSchema,
});
export const aiProviderCassetteSchema = v.strictObject({
  version: v.literal(CASSETTE_VERSION),
  recordedAt: v.pipe(v.string(), v.isoTimestamp()),
  entries: v.array(entrySchema),
});

export type AiProviderCassette = v.InferOutput<typeof aiProviderCassetteSchema>;
type CassetteEntry = AiProviderCassette["entries"][number];

type RecordOptions = {
  mode: "record";
  upstreamFetch: CassetteFetch;
  maxRequests: number;
  permittedOrigins: readonly string[];
  apiKey: string;
  recordedAt?: () => string;
};

type ReplayOptions = {
  mode: "replay";
  cassette: unknown;
};

export type CassetteFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type CassetteTransport = {
  fetch: CassetteFetch;
  finish: () => Promise<AiProviderCassette>;
};

export class AiCassetteError extends TaggedError("AiCassetteError")<{
  message: string;
}> {}

const fail = (message: string): never => {
  throw new AiCassetteError({ message: `AI cassette: ${message}` });
};

const contentTypeBase = (value: string) =>
  value.split(";", 1)[0]?.trim().toLowerCase() ?? "";

const containsSecret = (value: string, apiKey: string) =>
  apiKey.length > 0 && value.includes(apiKey);

const containsEncodedSecret = (value: string, apiKey: string) =>
  containsSecret(value, apiKey) || value.includes(encodeURIComponent(apiKey));

type CanonicalRequestOptions = {
  input: string | URL | Request;
  init: RequestInit | undefined;
  permittedOrigins?: ReadonlySet<string>;
  apiKey?: string;
};

const canonicalRequest = async ({
  input,
  init,
  permittedOrigins,
  apiKey,
}: CanonicalRequestOptions): Promise<CassetteEntry["request"]> => {
  const request =
    input instanceof Request
      ? input.clone()
      : new Request(input.toString(), init);
  const method = init?.method ?? request.method;
  const headers = new Headers(
    init?.headers ?? Object.fromEntries(request.headers.entries()),
  );
  const bodyText =
    init?.body === undefined
      ? await request.text()
      : await new Response(init.body).text();
  const url = new URL(request.url);
  if (permittedOrigins !== undefined && !permittedOrigins.has(url.origin)) {
    fail("request origin is not permitted");
  }
  if (permittedOrigins !== undefined && url.protocol !== "https:") {
    fail("recording requires HTTPS provider endpoints");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    fail("provider endpoint must not contain URL credentials");
  }
  if (method !== "POST") {
    fail("only POST requests can be recorded or replayed");
  }
  if (
    contentTypeBase(headers.get("content-type") ?? "") !== "application/json"
  ) {
    fail("only JSON requests can be recorded or replayed");
  }
  let body: StableStringifyInput;
  try {
    body = JSON.parse(bodyText);
  } catch {
    fail("request body is not valid JSON");
  }
  for (const key of [...url.searchParams.keys()]) {
    if (AUTH_QUERY_KEYS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  url.hash = "";
  const canonicalHeaders: Record<string, string> = {};
  for (const name of REQUEST_HEADER_NAMES) {
    const value = headers.get(name);
    if (value !== null) {
      canonicalHeaders[name] = value;
    }
  }
  const bodySha256 = new Bun.CryptoHasher("sha256")
    .update(stableStringify(body))
    .digest("hex");
  const canonical = {
    method: "POST" as const,
    url: url.toString(),
    headers: canonicalHeaders,
    bodySha256,
  };
  if (
    apiKey !== undefined &&
    containsEncodedSecret(stableStringify(canonical), apiKey)
  ) {
    fail("request metadata contains configured credentials");
  }
  return canonical;
};

type SanitizeJsonContext = {
  isUsage: boolean;
  normalizeCompletionId: boolean;
};

const ROOT_JSON_CONTEXT: SanitizeJsonContext = {
  isUsage: false,
  normalizeCompletionId: true,
};

const sanitizeJson = (value: unknown, context = ROOT_JSON_CONTEXT): unknown => {
  if (Array.isArray(value)) {
    return value.map((child) =>
      sanitizeJson(child, { isUsage: false, normalizeCompletionId: false }),
    );
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const objectKind = Object.entries(value).find(
    ([key]) => key === "object",
  )?.[1];
  const isCompletionEnvelope =
    context.normalizeCompletionId &&
    (objectKind === "chat.completion" ||
      objectKind === "chat.completion.chunk");
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !context.isUsage || (key !== "cost" && key !== "cost_details"),
      )
      .map(([key, child]) => {
        if (key === "request_id" || key === "requestId") {
          return [key, "[request-id]"];
        }
        if (key === "id" && isCompletionEnvelope) {
          return [key, "[completion-id]"];
        }
        return [
          key,
          sanitizeJson(child, {
            isUsage: key === "usage",
            normalizeCompletionId: false,
          }),
        ];
      }),
  );
};

type SanitizeResponseBodyOptions = {
  body: string;
  contentType: string;
  apiKey: string;
};

const sanitizeResponseBody = ({
  body,
  contentType,
  apiKey,
}: SanitizeResponseBodyOptions) => {
  if (containsSecret(body, apiKey)) {
    fail("provider response contains configured credentials");
  }
  if (JSON_CONTENT_TYPES.has(contentType) || contentType.endsWith("+json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return fail("provider returned invalid JSON");
    }
    const sanitized = JSON.stringify(sanitizeJson(parsed));
    if (containsSecret(sanitized, apiKey)) {
      return fail("provider response contains configured credentials");
    }
    return sanitized;
  }
  if (contentType === "text/event-stream") {
    return body
      .split("\n")
      .map((line) => {
        if (!line.startsWith("data:")) {
          return line;
        }
        const data = line.slice(5).trimStart();
        if (data === "[DONE]" || data.length === 0) {
          return line;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return fail("provider returned invalid SSE JSON data");
        }
        const sanitized = JSON.stringify(sanitizeJson(parsed));
        if (containsSecret(sanitized, apiKey)) {
          return fail("provider response contains configured credentials");
        }
        return `data: ${sanitized}`;
      })
      .join("\n");
  }
  return fail("provider response media type is unsupported");
};

const readBoundedBody = async (response: Response) => {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        fail("provider response exceeds the size limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
};

const captureResponse = async (response: Response, apiKey: string) => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    fail("provider response exceeds the size limit");
  }
  const contentType = contentTypeBase(
    response.headers.get("content-type") ?? "",
  );
  return {
    status: response.status,
    contentType,
    body: sanitizeResponseBody({
      body: await readBoundedBody(response),
      contentType,
      apiKey,
    }),
  };
};

const sameRequest = (
  left: CassetteEntry["request"],
  right: CassetteEntry["request"],
) => stableStringify(left) === stableStringify(right);

export const createCassetteFetch = (
  options: RecordOptions | ReplayOptions,
): CassetteTransport => {
  if (options.mode === "replay") {
    let cassette: AiProviderCassette;
    try {
      cassette = v.parse(aiProviderCassetteSchema, options.cassette);
    } catch {
      return fail("cassette is invalid");
    }
    let cursor = 0;
    let replayFailed = false;
    const replayFetch: CassetteFetch = async (input, init) => {
      const expected = cassette.entries.at(cursor);
      if (expected === undefined) {
        replayFailed = true;
        throw new AiCassetteError({
          message: "AI cassette: unexpected extra request during replay",
        });
      }
      cursor += 1;
      let actual: CassetteEntry["request"];
      try {
        actual = await canonicalRequest({ input, init });
      } catch {
        replayFailed = true;
        return fail("request was invalid during replay");
      }
      if (!sameRequest(actual, expected.request)) {
        replayFailed = true;
        fail("request did not match replay entry");
      }
      return new Response(expected.response.body, {
        status: expected.response.status,
        headers: { "content-type": expected.response.contentType },
      });
    };
    return {
      fetch: replayFetch,
      finish: async () => {
        const finishedCassette = await Promise.resolve(cassette);
        if (replayFailed) {
          fail("replay failed");
        }
        if (cursor !== finishedCassette.entries.length) {
          fail("replay did not consume every entry");
        }
        return finishedCassette;
      },
    };
  }

  if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests <= 0) {
    fail("maxRequests must be a positive integer");
  }
  if (options.apiKey.length === 0) {
    fail("apiKey must not be empty");
  }
  const origins = new Set(
    options.permittedOrigins.map((origin) => new URL(origin).origin),
  );
  if (origins.size === 0) {
    fail("at least one permitted origin is required");
  }
  const entries: Promise<CassetteEntry | null>[] = [];
  let reservedRequests = 0;
  let recordingFailed = false;
  let recordingStatus: "open" | "sealed" = "open";
  const recordFetch: CassetteFetch = async (input, init) => {
    if (recordingStatus === "sealed") {
      throw new AiCassetteError({
        message: "AI cassette: recording is sealed",
      });
    }
    if (reservedRequests >= options.maxRequests) {
      recordingFailed = true;
      throw new AiCassetteError({
        message: "AI cassette: request limit exceeded",
      });
    }
    reservedRequests += 1;
    const operation = async () => {
      try {
        const canonical = await canonicalRequest({
          input,
          init,
          permittedOrigins: origins,
          apiKey: options.apiKey,
        });
        const response = await options.upstreamFetch(input, {
          ...init,
          redirect: "error",
        });
        const recordedResponse = await captureResponse(
          response,
          options.apiKey,
        );
        const entry = {
          request: canonical,
          response: recordedResponse,
        };
        const sdkResponse = new Response(recordedResponse.body, {
          status: recordedResponse.status,
          headers: response.headers,
        });
        return { entry, response: sdkResponse };
      } catch (error) {
        recordingFailed = true;
        throw error;
      }
    };
    const pending = operation();
    entries.push(
      pending.then(
        ({ entry }) => entry,
        () => null,
      ),
    );
    return pending.then(({ response }) => response);
  };
  return {
    fetch: recordFetch,
    finish: async () => {
      if (recordingStatus === "sealed") {
        fail("recording is already sealed");
      }
      recordingStatus = "sealed";
      if (recordingFailed) {
        fail("recording failed");
      }
      const recordedEntries = await Promise.all(entries);
      if (recordingFailed) {
        fail("recording failed");
      }
      const cassetteEntries = recordedEntries.filter((entry) => entry !== null);
      if (cassetteEntries.length !== recordedEntries.length) {
        fail("recording failed");
      }
      return v.parse(aiProviderCassetteSchema, {
        version: CASSETTE_VERSION,
        recordedAt: (options.recordedAt ?? (() => new Date().toISOString()))(),
        entries: cassetteEntries,
      });
    },
  };
};
