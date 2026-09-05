import { EventType, maxIterations, toolDefinition } from "@tanstack/ai";
import type { AnyClientTool, AnyServerTool, ModelMessage } from "@tanstack/ai";
import { panic, Result, TaggedError } from "better-result";
import { isDeepStrictEqual } from "node:util";
import * as v from "valibot";

import {
  BYOK_MODEL_OPTIONS,
  CHAT_PDF_ATTACHMENT_MODEL_OPTIONS,
  DEFAULT_MODELS,
  isBYOKModelRoleSupported,
  isBYOKProviderRoleSupported,
  MODEL_ROLES,
} from "@stll/ai-catalog";
import type { ModelRole } from "@stll/ai-catalog";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { CachingDecision, OrgAIConfig } from "@/api/lib/ai-config";
import { streamChatChunks } from "@/api/lib/chat/tanstack-chat-runtime";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { providerSafeJsonSchemaOptionsForTanStackProvider } from "@/api/lib/provider-safe-json-schema";
import { buildBudgetEdgeSchema } from "@/api/lib/structured-output-budget-probe";
import {
  abortControllerFromSignal,
  generateTanStackObjectForRole,
  generateTanStackTextForRole,
  mergeGenerationOptions,
  resolveTanStackTextModel,
} from "@/api/lib/tanstack-ai-generate";
import type { TanStackTextFinishPolicy } from "@/api/lib/tanstack-ai-generate";
import { projectSchemaInputJsonSchema } from "@/api/lib/tanstack-ai-schema";
import { PDF_MIME_TYPE } from "@/api/mime-types";

import {
  CANARY_TIERS,
  CANARY_PROVIDERS,
  modelRoleMaxOutputTokens,
  structuredOutputBudgetEdgeMaxOutputTokens,
  structuredOutputModelRoleMaxOutputTokens,
  IMPOSSIBLE_STRING_MAX_LENGTH,
  NULL_WIDENING_CANARY_PROVIDERS,
  TOOL_CALL_PROBE_MAX_OUTPUT_TOKENS,
  weeklyCanaryRotation,
} from "./ai-provider-canary-config";
import type {
  CanaryProvider,
  WeeklyCanaryRotation,
} from "./ai-provider-canary-config";
import { createWeeklyToolShapeDefinition } from "./ai-provider-canary-weekly";

const CAPABILITY_ROLE = "fast" satisfies ModelRole;
const TOOL_CALL_ROLE = "chat" satisfies ModelRole;
const CAPABILITY_PROBE_TIMEOUT_MS = 20_000;
const MODEL_ROLE_PROBE_TIMEOUT_MS = 30_000;
const TOOL_ROUND_TRIP_PROBE_TIMEOUT_MS = 45_000;
// The budget-edge probe sends the largest schema the canary knows how to
// build and asks for one answer per property in it (~4K output tokens at
// OpenAI's documented 100 000-byte budget), against a grammar the provider
// compiles for that schema. Every other capability probe answers in one
// line, so the deadline they share aborts this one mid-generation; it gets
// the longest deadline the canary already waits on a single call.
const BUDGET_EDGE_PROBE_TIMEOUT_MS = TOOL_ROUND_TRIP_PROBE_TIMEOUT_MS;
// A provider's overload response ("high demand", 503) or a slow first
// answer must not read as a capability regression: three attempts, with the
// wait growing from 5s to 20s so a short capacity spike has time to pass.
const CANARY_PROBE_MAX_ATTEMPTS = 3;
const CANARY_PROBE_RETRY_DELAY_MS = 5000;
const CANARY_PROBE_RETRY_BACKOFF = 4;
const PROVIDER_ERROR_MESSAGE_MAX_LENGTH = 16_384;
const MILLISECONDS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
// Every text probe asserts what the provider returned, not that it finished
// inside the ceiling the probe itself set. Those ceilings are sized for a
// one-line answer, so a model that spends the whole budget reports a `length`
// finish; grading that as a failure would report the canary's own budget as
// provider drift. A moderated, tool-bearing, or unfinished run stays a
// failure: those are the provider regressions the probes exist to catch.
export const CANARY_TEXT_FINISH_POLICY =
  "allow-output-ceiling" satisfies TanStackTextFinishPolicy;
const SYNTHETIC_PROMPT = "Reply with exactly OK.";
export const PDF_CANARY_TOKEN = "STELLA_PDF_CANARY_OK";
const PDF_CANARY_FILENAME = "stella-provider-canary.pdf";
const PDF_CANARY_PROMPT =
  "Read the attached PDF and reply with exactly the uppercase identifier printed on its page.";
const TOOL_SCHEMA_PROMPT = "Do not call any tool. Reply with exactly OK.";
const TOOL_ROUND_TRIP_NAME = "canary_round_trip";
const TOOL_ROUND_TRIP_VALUE = "stella-canary";
const TOOL_ROUND_TRIP_COUNT = 7;
const TOOL_ROUND_TRIP_RESULT = "stella-tool-round-trip-ok";
const TOOL_ROUND_TRIP_PROMPT_PREFIX =
  `Call ${TOOL_ROUND_TRIP_NAME} exactly once with value "${TOOL_ROUND_TRIP_VALUE}" ` +
  `and count ${TOOL_ROUND_TRIP_COUNT}.`;
const TOOL_ROUND_TRIP_PROMPT_SUFFIX =
  "Then reply with only the confirmation value returned by the tool.";

export const toolRoundTripPromptForProvider = (
  provider: CanaryProvider,
): string => {
  if (NULL_WIDENING_CANARY_PROVIDERS.has(provider)) {
    return `${TOOL_ROUND_TRIP_PROMPT_PREFIX} Set optionalNote to null. ${TOOL_ROUND_TRIP_PROMPT_SUFFIX}`;
  }

  return `${TOOL_ROUND_TRIP_PROMPT_PREFIX} Do not include optionalNote. ${TOOL_ROUND_TRIP_PROMPT_SUFFIX}`;
};

const SAFE_CANARY_ERROR_MESSAGES = new Set([
  "Canary resolved an unexpected provider model.",
  "Provider did not execute the canary tool exactly once.",
  "Provider adapter preserved a synthetic null tool argument.",
  "Provider returned unexpected canary tool arguments.",
  "Provider did not execute the weekly canary tool exactly once.",
  "Provider returned unexpected weekly canary tool arguments.",
  "Provider did not read the attached PDF.",
  "Provider returned no text.",
]);

const createSyntheticPdf = (): Uint8Array => {
  const stream = `BT /F1 18 Tf 72 720 Td (${PDF_CANARY_TOKEN}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  const entries = offsets
    .map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf +=
    `xref\n0 ${objects.length + 1}\n` +
    `0000000000 65535 f \n${entries}` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
};

export const createPdfCanaryMessages = (): ModelMessage[] => [
  {
    role: "user",
    content: [
      { type: "text", content: PDF_CANARY_PROMPT },
      {
        type: "document",
        source: {
          type: "data",
          value: Buffer.from(createSyntheticPdf()).toString("base64"),
          mimeType: PDF_MIME_TYPE,
        },
        metadata: { filename: PDF_CANARY_FILENAME },
      },
    ],
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const SAFE_PROVIDER_CODES = new Set([
  "aborted",
  "api_error",
  "authentication_error",
  "billing_error",
  "error",
  "incomplete",
  "invalid_prompt",
  "invalid_request",
  "invalid_request_error",
  "max_tokens", // ai-anthropic: stream cut off at the output ceiling
  "not_found_error",
  "overloaded_error",
  "parse-error",
  "permission_error",
  "provider_error",
  "rate_limit_error",
  "rate_limit_exceeded",
  "refusal",
  "server_error",
  "tier_not_allowed", // ai-mistral: model outside the key's subscription tier
  "timeout",
  "timeout_error",
]);

const RETRYABLE_PROVIDER_CODES = new Set([
  "aborted",
  "api_error",
  "error",
  "incomplete",
  "overloaded_error",
  "provider_error",
  "rate_limit_error",
  "rate_limit_exceeded",
  "server_error",
  "timeout",
  "timeout_error",
]);

// A truncated or blocked response reaches the canary as a RUN_ERROR whose code
// is `incomplete` and whose message is the provider's own reason (the OpenAI
// adapter relays `incomplete_details.reason` verbatim). The code alone cannot
// separate an exhausted output budget from a filtered response, which are
// opposite findings: one is a probe budget to raise, the other is not. Keep the
// reason, allowlisted like every other value this canary prints.
const SAFE_INCOMPLETE_REASONS = new Set([
  "content_filter",
  "max_output_tokens",
]);

const RETRYABLE_TRANSPORT_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

type CanaryRunStage =
  | "before-tool-call"
  | "after-tool-call"
  | "after-tool-result";

const PROVIDER_ERROR_NESTED_KEYS = ["rawEvent", "error", "cause"] as const;

const providerErrorBodyFromMessage = (
  error: Record<string, unknown>,
): Record<string, unknown> | null => {
  if (PROVIDER_ERROR_NESTED_KEYS.some((key) => error[key] !== undefined)) {
    return null;
  }

  const message = error["message"];
  if (typeof message !== "string") {
    return null;
  }
  if (message.length > PROVIDER_ERROR_MESSAGE_MAX_LENGTH) {
    return null;
  }
  // Adapters prefix the body ("Mistral API error 403: {...}"); the JSON object
  // is the provider's, whatever precedes it is the adapter's.
  const bodyStart = message.indexOf("{");
  if (bodyStart === -1) {
    return null;
  }
  const body = message.slice(bodyStart);

  const parsed = Result.try((): unknown => JSON.parse(body));
  if (Result.isError(parsed) || !isRecord(parsed.value)) {
    return null;
  }
  return parsed.value;
};

const explicitRetryability = (error: unknown, depth = 0): boolean | null => {
  if (!isRecord(error)) {
    return null;
  }

  for (const key of ["retryable", "isRetryable"] as const) {
    const value = error[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  const smithyRetryable = error["$retryable"];
  if (typeof smithyRetryable === "boolean") {
    return smithyRetryable;
  }
  if (isRecord(smithyRetryable)) {
    return true;
  }

  if (depth < 3) {
    for (const key of PROVIDER_ERROR_NESTED_KEYS) {
      const nestedRetryability = explicitRetryability(error[key], depth + 1);
      if (nestedRetryability !== null) {
        return nestedRetryability;
      }
    }
    const messageRetryability = explicitRetryability(
      providerErrorBodyFromMessage(error),
      depth + 1,
    );
    if (messageRetryability !== null) {
      return messageRetryability;
    }
  }
  return null;
};

const rawProviderCode = (error: unknown, depth = 0): string | null => {
  if (!isRecord(error)) {
    return null;
  }

  if (depth < 3) {
    for (const key of PROVIDER_ERROR_NESTED_KEYS) {
      const nestedCode = rawProviderCode(error[key], depth + 1);
      if (nestedCode !== null) {
        return nestedCode;
      }
    }
    const messageCode = rawProviderCode(
      providerErrorBodyFromMessage(error),
      depth + 1,
    );
    if (messageCode !== null) {
      return messageCode;
    }
  }

  const code = error["code"];
  if (typeof code === "string") {
    return code;
  }
  // Anthropic and Mistral bodies name the failure class in `type`, not `code`.
  const type = error["type"];
  return typeof type === "string" ? type : null;
};

const safeProviderCode = (code: string | null): string | null =>
  code !== null && SAFE_PROVIDER_CODES.has(code) ? code : null;

// Matched whole, never substring: an unrecognized message is provider prose and
// stays out of the log.
const safeIncompleteReason = (error: unknown, depth = 0): string | null => {
  if (!isRecord(error)) {
    return null;
  }

  const message = error["message"];
  if (typeof message === "string" && SAFE_INCOMPLETE_REASONS.has(message)) {
    return message;
  }

  if (depth < 3) {
    for (const key of PROVIDER_ERROR_NESTED_KEYS) {
      const nestedReason = safeIncompleteReason(error[key], depth + 1);
      if (nestedReason !== null) {
        return nestedReason;
      }
    }
  }
  return null;
};

// The shared generate path rethrows every provider RUN_ERROR as a HandlerError
// whose 502 answers the handler's own HTTP caller and says nothing about the
// provider; the wrapper's code, message, and cause are the provider evidence.
// Read those, never the wrapper's status, or an Anthropic `max_tokens` cut-off
// and a Mistral 403 both print as "provider HTTP 502".
const providerEvidence = (error: unknown): unknown =>
  error instanceof HandlerError
    ? { code: error.code, message: error.message, cause: error.cause }
    : error;

const providerStatus = (error: unknown, depth = 0): number | null => {
  if (!isRecord(error)) {
    return null;
  }

  if (depth < 3) {
    for (const key of PROVIDER_ERROR_NESTED_KEYS) {
      const nestedStatus = providerStatus(error[key], depth + 1);
      if (nestedStatus !== null) {
        return nestedStatus;
      }
    }
    const messageStatus = providerStatus(
      providerErrorBodyFromMessage(error),
      depth + 1,
    );
    if (messageStatus !== null) {
      return messageStatus;
    }
  }

  for (const key of [
    "status",
    "statusCode",
    "raw_status_code",
    "code",
  ] as const) {
    const value = error[key];
    // Adapters relay an SDK status as `code: String(err.status)`.
    const numeric =
      typeof value === "string" && /^\d{3}$/u.test(value)
        ? Number(value)
        : value;
    if (
      typeof numeric === "number" &&
      Number.isInteger(numeric) &&
      numeric >= 100 &&
      numeric <= 599
    ) {
      return numeric;
    }
  }
  return null;
};

const isRetryableProviderStatus = (status: number): boolean =>
  status === 429 || status >= 500;

const isRetryableProviderCode = (code: string | null): boolean =>
  code !== null &&
  (RETRYABLE_PROVIDER_CODES.has(code) || RETRYABLE_TRANSPORT_CODES.has(code));

const isTerminalProviderCode = (code: string | null): boolean =>
  code !== null &&
  SAFE_PROVIDER_CODES.has(code) &&
  !RETRYABLE_PROVIDER_CODES.has(code);

const terminalProviderCode = (error: unknown, depth = 0): string | null => {
  if (!isRecord(error)) {
    return null;
  }

  for (const key of ["code", "type"] as const) {
    const value = error[key];
    if (typeof value === "string" && isTerminalProviderCode(value)) {
      return value;
    }
  }

  if (depth < 3) {
    for (const key of PROVIDER_ERROR_NESTED_KEYS) {
      const nestedCode = terminalProviderCode(error[key], depth + 1);
      if (nestedCode !== null) {
        return nestedCode;
      }
    }
    const messageCode = terminalProviderCode(
      providerErrorBodyFromMessage(error),
      depth + 1,
    );
    if (messageCode !== null) {
      return messageCode;
    }
  }
  return null;
};

// Every adapter collapses a provider failure into a RUN_ERROR carrying only the
// provider's message and code (@tanstack/ai `toRunErrorPayload`), and the shared
// generate path rethrows that event as HTTP 502, so a rejected key is
// indistinguishable from a capability regression by status alone. Each signature
// is matched case-insensitively against the message, code, and type fields on
// the error chain.
export const CREDENTIAL_REJECTION_SIGNATURES = [
  "authentication failed", // bedrock-converse: bearer-key rejection body
  "authentication_error", // ai-anthropic: error body type
  "invalid x-api-key", // ai-anthropic: error body message
  "invalid_api_key", // ai-openai, openrouter: error body code
  "incorrect api key", // ai-openai: error body message
  "api key not valid", // ai-gemini: rejection message
  "permission_denied", // ai-gemini: status for a revoked or restricted key
  "unauthenticated", // ai-gemini: status for a missing or expired key
  "no auth credentials found", // openrouter: 401 body message
  "unauthorized", // ai-mistral: 401 body message
] as const;

// Only 401 rejects a credential on status alone: a 403 is also how a provider
// answers a valid key that lacks entitlement to a model, so it must carry an
// auth signature as well.
export const CREDENTIAL_REJECTION_STATUSES = [401] as const;

type CredentialRejectionReason =
  | (typeof CREDENTIAL_REJECTION_SIGNATURES)[number]
  | `HTTP ${(typeof CREDENTIAL_REJECTION_STATUSES)[number]}`;

export type CanaryFailure =
  | { kind: "credential-rejected"; reason: CredentialRejectionReason }
  | { kind: "provider-failure" };

const PROVIDER_FAILURE = {
  kind: "provider-failure",
} as const satisfies CanaryFailure;

const CREDENTIAL_SIGNATURE_KEYS = ["message", "code", "type"] as const;

const credentialSignature = (
  value: unknown,
): CredentialRejectionReason | null => {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.toLowerCase();
  return (
    CREDENTIAL_REJECTION_SIGNATURES.find((signature) =>
      normalized.includes(signature),
    ) ?? null
  );
};

const credentialRejectionSignature = (
  error: unknown,
  depth = 0,
): CredentialRejectionReason | null => {
  const direct = credentialSignature(error);
  if (direct !== null) {
    return direct;
  }
  if (!isRecord(error)) {
    return null;
  }

  for (const key of CREDENTIAL_SIGNATURE_KEYS) {
    const signature = credentialSignature(error[key]);
    if (signature !== null) {
      return signature;
    }
  }
  if (depth >= 3) {
    return null;
  }
  for (const key of PROVIDER_ERROR_NESTED_KEYS) {
    const nested = credentialRejectionSignature(error[key], depth + 1);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
};

// Provider preflight rejections are deterministic for the request shape, so
// retrying is waste, and the shared generate path wraps them in a 502 whose
// status says nothing about the cause. Each signature is matched
// case-insensitively against the message on the error chain and summarised
// with a fixed phrase; the provider's own text never reaches the log.
const PROVIDER_REJECTION_SIGNATURES = [
  ["exceeds the model limit", "output ceiling above model limit"], // bedrock-converse
  ["model access is denied", "model access denied"], // bedrock-converse
  [
    "not available in your subscription tier",
    "model outside subscription tier",
  ], // ai-mistral
] as const;
type ProviderRejectionReason =
  (typeof PROVIDER_REJECTION_SIGNATURES)[number][1];

const providerRejectionSignature = (
  value: unknown,
): ProviderRejectionReason | null => {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.toLowerCase();
  return (
    PROVIDER_REJECTION_SIGNATURES.find(([signature]) =>
      normalized.includes(signature),
    )?.[1] ?? null
  );
};

export const providerRejectionReason = (
  error: unknown,
  depth = 0,
): ProviderRejectionReason | null => {
  if (error instanceof CanaryProviderRunError) {
    return error.rejectionReason;
  }
  const direct = providerRejectionSignature(error);
  if (direct !== null) {
    return direct;
  }
  if (!isRecord(error)) {
    return null;
  }
  const message = providerRejectionSignature(error["message"]);
  if (message !== null) {
    return message;
  }
  if (depth >= 3) {
    return null;
  }
  for (const key of PROVIDER_ERROR_NESTED_KEYS) {
    const nested = providerRejectionReason(error[key], depth + 1);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
};

const credentialRejectionStatus = (
  status: number | null,
): CredentialRejectionReason | null => {
  const match = CREDENTIAL_REJECTION_STATUSES.find(
    (candidate) => candidate === status,
  );
  return match === undefined ? null : `HTTP ${match}`;
};

const canaryEventFailure = (event: unknown): CanaryFailure => {
  const statusReason = credentialRejectionStatus(providerStatus(event));
  if (statusReason !== null) {
    return { kind: "credential-rejected", reason: statusReason };
  }

  const signature = credentialRejectionSignature(event);
  return signature === null
    ? PROVIDER_FAILURE
    : { kind: "credential-rejected", reason: signature };
};

export class CanaryProviderRunError extends TypeError {
  readonly code: string | null;
  readonly failure: CanaryFailure;
  readonly incompleteReason: string | null;
  readonly rejectionReason: ProviderRejectionReason | null;
  readonly retryCode: string | null;
  readonly retryable: boolean | null;
  readonly stage: CanaryRunStage;
  readonly status: number | null;
  readonly terminalCode: string | null;

  constructor(event: unknown, stage: CanaryRunStage) {
    super("Provider stream failed.");
    this.name = "CanaryProviderRunError";
    this.retryCode = rawProviderCode(event);
    this.retryable = explicitRetryability(event);
    this.code = safeProviderCode(this.retryCode);
    this.failure = canaryEventFailure(event);
    this.incompleteReason = safeIncompleteReason(event);
    this.rejectionReason = providerRejectionReason(event);
    this.stage = stage;
    this.status = providerStatus(event);
    this.terminalCode = terminalProviderCode(event);
  }
}

export const classifyCanaryFailure = (error: unknown): CanaryFailure =>
  error instanceof CanaryProviderRunError
    ? error.failure
    : canaryEventFailure(error);

type CanaryCredentialRejectedOptions = {
  label: string;
  provider: CanaryProvider;
  reason: CredentialRejectionReason;
};

// A TypeError so the top-level handler prints this bounded message; every part
// of it is either a canary literal or a canary-built label.
export class CanaryCredentialRejectedError extends TypeError {
  constructor({ label, provider, reason }: CanaryCredentialRejectedOptions) {
    super(
      `${provider}: credential rejected (${label}, ${reason}); ` +
        "rotate AI_CANARY_API_KEY for this provider",
    );
    this.name = "CanaryCredentialRejectedError";
  }
}

export const isRetryableCanaryError = (
  error: unknown,
  signal: AbortSignal,
): boolean => {
  if (signal.aborted) {
    return true;
  }

  // A rejected credential fails every remaining attempt identically.
  if (classifyCanaryFailure(error).kind === "credential-rejected") {
    return false;
  }

  // So does a preflight rejection of the request shape.
  if (providerRejectionReason(error) !== null) {
    return false;
  }

  if (error instanceof CanaryProviderRunError) {
    if (error.terminalCode !== null) {
      return false;
    }
    if (error.retryable !== null) {
      return error.retryable;
    }
    if (error.status !== null) {
      return isRetryableProviderStatus(error.status);
    }
    return error.retryCode === null || isRetryableProviderCode(error.retryCode);
  }

  const evidence = providerEvidence(error);
  const code = rawProviderCode(evidence);
  if (terminalProviderCode(evidence) !== null) {
    return false;
  }
  const retryable = explicitRetryability(evidence);
  if (retryable !== null) {
    return retryable;
  }
  const status = providerStatus(evidence);
  if (status !== null) {
    return isRetryableProviderStatus(status);
  }
  return isRetryableProviderCode(code);
};

type CanaryProbeResult =
  | { attempts: number; status: "passed" }
  | {
      attempts: number;
      error: unknown;
      signal: AbortSignal;
      status: "failed";
    };

type RunCanaryProbeOptions = {
  retryDelayMs?: number;
  run: (signal: AbortSignal) => Promise<void>;
  timeoutMs: number;
  wait?: (delayMs: number) => Promise<void>;
};

export const runCanaryProbe = async ({
  retryDelayMs = CANARY_PROBE_RETRY_DELAY_MS,
  run: runAttempt,
  timeoutMs,
  wait = Bun.sleep,
}: RunCanaryProbeOptions): Promise<CanaryProbeResult> => {
  for (let attempt = 1; attempt <= CANARY_PROBE_MAX_ATTEMPTS; attempt += 1) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      await runAttempt(signal);
      return { attempts: attempt, status: "passed" };
    } catch (error) {
      if (
        attempt === CANARY_PROBE_MAX_ATTEMPTS ||
        !isRetryableCanaryError(error, signal)
      ) {
        return { attempts: attempt, error, signal, status: "failed" };
      }
      await wait(retryDelayMs * CANARY_PROBE_RETRY_BACKOFF ** (attempt - 1));
    }
  }

  return panic("Canary retry loop exhausted without a result.");
};

const NO_CACHING = {
  enabled: false,
  reason: "org-disabled",
} as const satisfies CachingDecision;

const CANARY_CACHING = {
  enabled: true,
  ttl: "5m",
  scopeKey: "stella-synthetic-provider-canary",
} as const satisfies CachingDecision;

// Synthetic provider-contract probes: no tenant workspace scope to guard.
const NO_TENANT_SCOPE = [] as const;

const structuredOutputSchema = v.strictObject({ ok: v.literal(true) });

// Exercises the nested shape and the value constraints (array bounds, string
// lengths) that provider schema compilers treat differently from a trivial
// object. The content is synthetic; this canary exists to catch provider drift
// in the exact shared projection used by production structured-output calls.
const nestedStructuredOutputSchema = v.strictObject({
  entries: v.pipe(
    v.array(
      v.strictObject({
        heading: v.pipe(v.string(), v.maxLength(120)),
        status: v.picklist(["accepted", "needs-work", "not-applicable"]),
        explanation: v.string(),
        primaryEvidence: v.pipe(
          v.array(v.strictObject({ source: v.string(), locator: v.string() })),
          v.maxLength(8),
        ),
        secondaryEvidence: v.pipe(
          v.array(v.strictObject({ source: v.string(), locator: v.string() })),
          v.maxLength(8),
        ),
        suggestedRevision: v.nullable(v.string()),
      }),
    ),
    v.maxLength(200),
  ),
});

const strictTool = toolDefinition({
  name: "canary_closed_tool",
  description: "Synthetic no-op tool with a closed input schema.",
  inputSchema: toTanStackToolSchema(
    v.strictObject({ value: v.literal("canary") }),
  ),
}).client();

const openMapTool = toolDefinition({
  name: "canary_open_map_tool",
  description: "Synthetic no-op tool with a free-form map input.",
  inputSchema: toTanStackToolSchema(
    v.strictObject({ values: v.record(v.string(), v.unknown()) }),
  ),
}).client();

export const toolRoundTripInputSchema = v.strictObject({
  count: v.literal(TOOL_ROUND_TRIP_COUNT),
  // Strict adapters require every provider-facing property and widen this
  // optional string with null. The provider is asked for that synthetic null;
  // the adapter must remove it before the server validates and executes the
  // tool because null is deliberately invalid in this application schema.
  optionalNote: v.optional(
    v.pipe(v.string(), v.maxLength(IMPOSSIBLE_STRING_MAX_LENGTH)),
  ),
  value: v.literal(TOOL_ROUND_TRIP_VALUE),
});

// Mistral rejects `pattern` in strict tool schemas. Its adapter widens every
// optional enum with null, so an empty enum becomes `[null]` on the wire: one
// deterministic omission marker and no non-null value for the model to choose.
const MISTRAL_TOOL_ROUND_TRIP_JSON_SCHEMA = {
  type: "object",
  properties: {
    count: { type: "number", enum: [TOOL_ROUND_TRIP_COUNT] },
    optionalNote: { type: "string", enum: [] },
    value: { type: "string", enum: [TOOL_ROUND_TRIP_VALUE] },
  },
  required: ["count", "value"],
  additionalProperties: false,
} as const;

const toolRoundTripStandardSchema = toTanStackToolSchema(
  toolRoundTripInputSchema,
);

const MISTRAL_TOOL_ROUND_TRIP_INPUT_SCHEMA = {
  ...toolRoundTripStandardSchema,
  "~standard": {
    ...toolRoundTripStandardSchema["~standard"],
    jsonSchema: {
      ...toolRoundTripStandardSchema["~standard"].jsonSchema,
      input: () => MISTRAL_TOOL_ROUND_TRIP_JSON_SCHEMA,
    },
  },
} as const;

export const toolRoundTripInputSchemaForProvider = (
  provider: CanaryProvider,
) => {
  if (provider === "mistral") {
    return MISTRAL_TOOL_ROUND_TRIP_INPUT_SCHEMA;
  }

  return toolRoundTripStandardSchema;
};

const toolRoundTripOutputSchema = v.strictObject({
  confirmation: v.literal(TOOL_ROUND_TRIP_RESULT),
});

type ProbeBase = {
  timeoutMs: number;
  run: (context: CanaryContext, signal: AbortSignal) => Promise<void>;
};

type CapabilityProbe = ProbeBase & {
  type: "capability";
  name: string;
};

type ModelRoleProbe = ProbeBase & {
  type: "model-role";
  role: ModelRole;
};

type StructuredOutputModelRoleProbe = ProbeBase & {
  type: "structured-output-role";
  role: ModelRole;
};

type Probe = CapabilityProbe | ModelRoleProbe | StructuredOutputModelRoleProbe;

type CanaryContext = {
  config: OrgAIConfig;
  provider: CanaryProvider;
};

type PdfCanarySelection = {
  modelId: string;
  role: "chat" | "pdf";
};

export const pdfCanarySelection = (
  provider: CanaryProvider,
): PdfCanarySelection | null => {
  if (isBYOKProviderRoleSupported({ provider, role: "pdf" })) {
    return { modelId: DEFAULT_MODELS[provider].pdf, role: "pdf" };
  }

  const modelId = CHAT_PDF_ATTACHMENT_MODEL_OPTIONS[provider].at(0);
  return modelId === undefined ? null : { modelId, role: "chat" };
};

type WeeklyCanaryContext = CanaryContext & {
  rotatedConfig: OrgAIConfig;
  rotation: WeeklyCanaryRotation;
};

const modelRoleProbes = MODEL_ROLES.map(
  (role) =>
    ({
      type: "model-role",
      role,
      timeoutMs: MODEL_ROLE_PROBE_TIMEOUT_MS,
      run: async (context, signal) => {
        await runModelRoleProbe({ context, role, signal });
      },
    }) satisfies ModelRoleProbe,
);

const structuredOutputModelRoleProbes = MODEL_ROLES.map(
  (role) =>
    ({
      type: "structured-output-role",
      role,
      timeoutMs: MODEL_ROLE_PROBE_TIMEOUT_MS,
      run: async (context, signal) => {
        await runStructuredOutputModelRoleProbe({ context, role, signal });
      },
    }) satisfies StructuredOutputModelRoleProbe,
);

const capabilityProbes = [
  {
    type: "capability",
    name: "structured-output",
    timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS,
    run: async ({ config, provider }, signal) => {
      await generateTanStackObjectForRole({
        abortSignal: signal,
        caching: NO_CACHING,
        maxOutputTokens: structuredOutputModelRoleMaxOutputTokens({
          modelId: DEFAULT_MODELS[provider][CAPABILITY_ROLE],
          role: CAPABILITY_ROLE,
        }),
        organizationId: null,
        orgAIConfig: config,
        outputSchema: structuredOutputSchema,
        prompt: "Return an object whose ok field is true.",
        role: CAPABILITY_ROLE,
        serviceTier: "standard",
        tenantWorkspaceIds: NO_TENANT_SCOPE,
      });
    },
  },
  {
    // A schema sized to the widest a provider currently accepts for this
    // application's own workflow-batch shape (see
    // `buildBudgetEdgeSchema`/`STRUCTURED_OUTPUT_BUDGETS`), rather than the
    // trivial one-field schema the "structured-output" probe above sends.
    // The daily edge probe exists to catch a provider tightening its
    // constrained-decoding grammar limits here, not in a user's workflow run.
    type: "capability",
    name: "structured-output-budget-edge",
    timeoutMs: BUDGET_EDGE_PROBE_TIMEOUT_MS,
    run: async ({ config, provider }, signal) => {
      const modelId = DEFAULT_MODELS[provider][CAPABILITY_ROLE];
      const edge = buildBudgetEdgeSchema({ provider, modelId });
      console.log(
        `[ai-canary] ${provider}/structured-output-budget-edge: ` +
          `${edge.propertyCount} properties, ${edge.measured.bytes}/` +
          `${edge.budget.maxSchemaBytes} bytes, ` +
          `${edge.measured.unionParameters}/${edge.budget.maxUnionParameters} ` +
          `union parameters (${edge.budget.basis} budget, compiler=${edge.compiler})`,
      );
      await generateTanStackObjectForRole({
        abortSignal: signal,
        caching: NO_CACHING,
        maxOutputTokens: structuredOutputBudgetEdgeMaxOutputTokens({
          modelId,
          propertyCount: edge.propertyCount,
        }),
        organizationId: null,
        orgAIConfig: config,
        outputSchema: edge.outputSchema,
        prompt:
          "Return an object with one entry per property key in the " +
          'schema. For each, set "answer" to null and "justification" to ' +
          "an empty array.",
        role: CAPABILITY_ROLE,
        serviceTier: "standard",
        tenantWorkspaceIds: NO_TENANT_SCOPE,
      });
    },
  },
  {
    type: "capability",
    name: "strict-tool-schema",
    timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS,
    run: async (context, signal) => {
      const output = await runToolProbe({
        context,
        prompt: TOOL_SCHEMA_PROMPT,
        role: CAPABILITY_ROLE,
        signal,
        tool: strictTool,
      });
      requireNonEmptyText(output);
    },
  },
  {
    type: "capability",
    name: "open-map-tool-schema",
    timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS,
    run: async (context, signal) => {
      const output = await runToolProbe({
        context,
        prompt: TOOL_SCHEMA_PROMPT,
        role: CAPABILITY_ROLE,
        signal,
        tool: openMapTool,
      });
      requireNonEmptyText(output);
    },
  },
  {
    type: "capability",
    name: "tool-call-round-trip",
    timeoutMs: TOOL_ROUND_TRIP_PROBE_TIMEOUT_MS,
    run: async (context, signal) => {
      await runToolCallRoundTripProbe({ context, signal });
    },
  },
  {
    type: "capability",
    name: "prompt-caching",
    timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS,
    run: async ({ config, provider }, signal) => {
      const output = await generateTanStackTextForRole({
        abortSignal: signal,
        caching: CANARY_CACHING,
        finishPolicy: CANARY_TEXT_FINISH_POLICY,
        maxOutputTokens: modelRoleMaxOutputTokens({
          modelId: DEFAULT_MODELS[provider][CAPABILITY_ROLE],
          role: CAPABILITY_ROLE,
        }),
        organizationId: null,
        orgAIConfig: config,
        prompt: SYNTHETIC_PROMPT,
        role: CAPABILITY_ROLE,
        serviceTier: "standard",
        system: "This is a synthetic provider-contract canary.",
        systemPromptOrigin: "server-built",
        tenantWorkspaceIds: NO_TENANT_SCOPE,
      });
      requireNonEmptyText(output);
    },
  },
] as const satisfies readonly CapabilityProbe[];

export const canaryCapabilityProbeTimeout = (
  name: string,
): number | undefined =>
  capabilityProbes.find((probe) => probe.name === name)?.timeoutMs;

const probes = [
  ...modelRoleProbes,
  ...structuredOutputModelRoleProbes,
  ...capabilityProbes,
] satisfies readonly Probe[];

type RunModelRoleProbeOptions = {
  context: CanaryContext;
  role: ModelRole;
  signal: AbortSignal;
};

const runModelRoleProbe = async ({
  context: { config, provider },
  role,
  signal,
}: RunModelRoleProbeOptions): Promise<void> => {
  const selection =
    role === "pdf"
      ? pdfCanarySelection(provider)
      : { modelId: DEFAULT_MODELS[provider][role], role };
  if (selection === null) {
    throw new TypeError("Canary resolved an unexpected provider model.");
  }
  const probeConfig =
    selection.role === role
      ? config
      : {
          ...config,
          overrideModels: {
            ...config.overrideModels,
            [selection.role]: {
              modelId: selection.modelId,
              provider,
            },
          },
        };
  const model = resolveTanStackTextModel({
    organizationId: null,
    orgAIConfig: probeConfig,
    role: selection.role,
  });
  if (model.provider !== provider || model.modelId !== selection.modelId) {
    throw new TypeError("Canary resolved an unexpected provider model.");
  }

  const output = await generateTanStackTextForRole({
    abortSignal: signal,
    caching: NO_CACHING,
    finishPolicy: CANARY_TEXT_FINISH_POLICY,
    maxOutputTokens: modelRoleMaxOutputTokens({
      modelId: selection.modelId,
      role,
    }),
    ...(role === "pdf"
      ? { messages: createPdfCanaryMessages() }
      : { prompt: SYNTHETIC_PROMPT }),
    organizationId: null,
    orgAIConfig: probeConfig,
    role: selection.role,
    serviceTier: "standard",
    tenantWorkspaceIds: NO_TENANT_SCOPE,
  });
  requireExpectedRoleOutput(output, role);
};

const runStructuredOutputModelRoleProbe = async ({
  context: { config, provider },
  role,
  signal,
}: RunModelRoleProbeOptions): Promise<void> => {
  await generateTanStackObjectForRole({
    abortSignal: signal,
    caching: NO_CACHING,
    maxOutputTokens: structuredOutputModelRoleMaxOutputTokens({
      modelId: DEFAULT_MODELS[provider][role],
      role,
    }),
    organizationId: null,
    orgAIConfig: config,
    outputSchema: nestedStructuredOutputSchema,
    prompt: "Return an object with an empty entries array.",
    role,
    serviceTier: "standard",
    tenantWorkspaceIds: NO_TENANT_SCOPE,
  });
};

type RunWeeklyModelRoleProbeOptions = {
  context: WeeklyCanaryContext;
  role: ModelRole;
  signal: AbortSignal;
};

const runWeeklyModelRoleProbe = async ({
  context: { provider, rotatedConfig, rotation },
  role,
  signal,
}: RunWeeklyModelRoleProbeOptions): Promise<void> => {
  const model = resolveTanStackTextModel({
    organizationId: null,
    orgAIConfig: rotatedConfig,
    role,
  });
  if (model.provider !== provider || model.modelId !== rotation.modelId) {
    throw new TypeError("Canary resolved an unexpected provider model.");
  }

  const output = await generateTanStackTextForRole({
    abortSignal: signal,
    caching: NO_CACHING,
    finishPolicy: CANARY_TEXT_FINISH_POLICY,
    maxOutputTokens: modelRoleMaxOutputTokens({
      modelId: rotation.modelId,
      role,
    }),
    ...(role === "pdf"
      ? { messages: createPdfCanaryMessages() }
      : { prompt: SYNTHETIC_PROMPT }),
    organizationId: null,
    orgAIConfig: rotatedConfig,
    role,
    serviceTier: "standard",
    tenantWorkspaceIds: NO_TENANT_SCOPE,
  });
  requireExpectedRoleOutput(output, role);
};

const runWeeklyStructuredOutputModelRoleProbe = async ({
  context: { rotatedConfig, rotation },
  role,
  signal,
}: RunWeeklyModelRoleProbeOptions): Promise<void> => {
  await generateTanStackObjectForRole({
    abortSignal: signal,
    caching: NO_CACHING,
    maxOutputTokens: structuredOutputModelRoleMaxOutputTokens({
      modelId: rotation.modelId,
      role,
    }),
    organizationId: null,
    orgAIConfig: rotatedConfig,
    outputSchema: nestedStructuredOutputSchema,
    prompt: "Return an object with an empty entries array.",
    role,
    serviceTier: "standard",
    tenantWorkspaceIds: NO_TENANT_SCOPE,
  });
};

type RunToolCallRoundTripProbeOptions = {
  context: CanaryContext;
  signal: AbortSignal;
};

const runToolCallRoundTripProbe = async ({
  context,
  signal,
}: RunToolCallRoundTripProbeOptions): Promise<void> => {
  const observedInputs: unknown[] = [];
  const tool = toolDefinition({
    name: TOOL_ROUND_TRIP_NAME,
    description:
      "Call exactly once with the value and count requested by the user.",
    inputSchema: toolRoundTripInputSchemaForProvider(context.provider),
    outputSchema: toTanStackToolSchema(toolRoundTripOutputSchema),
  }).server((input) => {
    observedInputs.push(input);
    return { confirmation: TOOL_ROUND_TRIP_RESULT };
  });

  await runToolProbe({
    context,
    prompt: toolRoundTripPromptForProvider(context.provider),
    role: TOOL_CALL_ROLE,
    signal,
    tool,
  });

  if (observedInputs.length !== 1) {
    throw new TypeError(
      "Provider did not execute the canary tool exactly once.",
    );
  }
  const observedInput = observedInputs.at(0);
  if (
    !isRecord(observedInput) ||
    observedInput["count"] !== TOOL_ROUND_TRIP_COUNT ||
    observedInput["value"] !== TOOL_ROUND_TRIP_VALUE
  ) {
    throw new TypeError("Provider returned unexpected canary tool arguments.");
  }
  // Only the synthetic null is the adapter's defect. An empty string is a
  // model choice the application schema accepts (maxLength 0), so it is not a
  // provider-contract finding.
  if (observedInput["optionalNote"] === null) {
    throw new TypeError(
      "Provider adapter preserved a synthetic null tool argument.",
    );
  }
};

type RunWeeklyToolShapeProbeOptions = {
  context: WeeklyCanaryContext;
  signal: AbortSignal;
};

type RequireWeeklyToolExecutionOptions = {
  expectedInputs: readonly unknown[];
  observedInputs: readonly unknown[];
};

export const requireWeeklyToolExecution = ({
  expectedInputs,
  observedInputs,
}: RequireWeeklyToolExecutionOptions): void => {
  if (observedInputs.length !== 1) {
    throw new TypeError(
      "Provider did not execute the weekly canary tool exactly once.",
    );
  }
  const observedInput = observedInputs.at(0);
  if (
    !expectedInputs.some((expectedInput) =>
      isDeepStrictEqual(observedInput, expectedInput),
    )
  ) {
    throw new TypeError(
      "Provider returned unexpected weekly canary tool arguments.",
    );
  }
};

const runWeeklyToolShapeProbe = async ({
  context,
  signal,
}: RunWeeklyToolShapeProbeOptions): Promise<void> => {
  const observedInputs: unknown[] = [];
  const { expectedInputs, prompt, tool } = createWeeklyToolShapeDefinition(
    context.rotation.toolShape,
    context.provider,
    observedInputs,
  );
  await runToolProbe({
    context: { config: context.rotatedConfig, provider: context.provider },
    prompt,
    role: TOOL_CALL_ROLE,
    signal,
    tool,
  });

  requireWeeklyToolExecution({ expectedInputs, observedInputs });
};

type RunToolProbeOptions = {
  context: CanaryContext;
  prompt: string;
  role: ModelRole;
  signal: AbortSignal;
  tool: AnyClientTool | AnyServerTool;
};

// Every tool-execution probe gets the reasoning budget here, not at the call
// site, so a caller cannot hand a reasoning-capable model a short-reply budget
// and turn a truncated stream into a false provider failure.
const runToolProbe = async ({
  context: { config, provider },
  prompt,
  role,
  signal,
  tool,
}: RunToolProbeOptions): Promise<string> => {
  const model = resolveTanStackTextModel({
    organizationId: null,
    orgAIConfig: config,
    role,
  });
  const inputSchema = projectSchemaInputJsonSchema(
    tool.inputSchema,
    providerSafeJsonSchemaOptionsForTanStackProvider(provider, "tool"),
  );
  const projectedTool = {
    ...tool,
    ...(inputSchema === undefined ? {} : { inputSchema }),
  };

  const stream = streamChatChunks({
    adapter: model.adapter,
    abortController: abortControllerFromSignal(signal),
    agentLoopStrategy: maxIterations(2),
    messages: [{ role: "user", content: prompt }],
    modelOptions: mergeGenerationOptions({
      caching: NO_CACHING,
      model,
      maxOutputTokens: TOOL_CALL_PROBE_MAX_OUTPUT_TOKENS,
      serviceTier: "standard",
      temperature: 0,
    }),
    tools: [projectedTool],
  });
  let output = "";
  let stage: CanaryRunStage = "before-tool-call";
  for await (const chunk of stream) {
    if (chunk.type === EventType.TEXT_MESSAGE_CONTENT && chunk.delta) {
      output += chunk.delta;
    }
    if (chunk.type === EventType.TOOL_CALL_END) {
      stage = "after-tool-call";
    }
    if (chunk.type === EventType.TOOL_CALL_RESULT) {
      stage = "after-tool-result";
    }
    if (chunk.type === EventType.RUN_ERROR) {
      throw new CanaryProviderRunError(chunk, stage);
    }
  }
  return output;
};

const requireNonEmptyText = (output: string): void => {
  if (output.trim().length === 0) {
    throw new TypeError("Provider returned no text.");
  }
};

const requireExpectedRoleOutput = (output: string, role: ModelRole): void => {
  requireNonEmptyText(output);
  if (role === "pdf" && output.trim() !== PDF_CANARY_TOKEN) {
    throw new TypeError("Provider did not read the attached PDF.");
  }
};

const modelSelections = (provider: CanaryProvider, rotatedModelId?: string) => {
  const modelIdForRole = (role: ModelRole) =>
    rotatedModelId !== undefined &&
    isBYOKModelRoleSupported({ modelId: rotatedModelId, provider, role })
      ? rotatedModelId
      : DEFAULT_MODELS[provider][role];

  return {
    fast: { provider, modelId: modelIdForRole("fast") },
    chat: { provider, modelId: modelIdForRole("chat") },
    reasoning: { provider, modelId: modelIdForRole("reasoning") },
    pdf: { provider, modelId: modelIdForRole("pdf") },
  };
};

/**
 * Every model id the catalog can put in front of a user for a provider: the
 * default of each role plus the whole BYOK list, in catalog order, once
 * each. The catalog probe below exercises all of them on every run, so a
 * model a provider retires is caught the next night rather than whenever the
 * weekly rotation happens to reach it.
 */
export const catalogModelIds = (provider: CanaryProvider): string[] => {
  const ids = new Set<string>();
  for (const role of MODEL_ROLES) {
    ids.add(DEFAULT_MODELS[provider][role]);
  }
  for (const modelId of BYOK_MODEL_OPTIONS[provider]) {
    ids.add(modelId);
  }
  return [...ids];
};

// The cheapest role: a short reply, no reasoning budget, no attachment.
const CATALOG_PROBE_ROLE = "fast" satisfies ModelRole;
// The catalog sweep is sequential (one provider quota) and each id may retry
// with backoff, so the whole sweep gets one aggregate budget: ids left when
// it runs out are reported as failures rather than silently unprobed, and the
// job stays inside the workflow timeout on a degraded provider.
export const CATALOG_SWEEP_BUDGET_MS = 10 * 60 * 1000;

type CreateCanaryConfigOptions = {
  apiKey: string;
  provider: CanaryProvider;
  rotatedModelId?: string;
};

const createCanaryConfig = ({
  apiKey,
  provider,
  rotatedModelId,
}: CreateCanaryConfigOptions): OrgAIConfig => {
  switch (provider) {
    case "google":
    case "openrouter":
    case "openai":
    case "anthropic":
    case "bedrock":
    case "mistral":
      return {
        providers: [{ provider, apiKey }],
        overrideModels: modelSelections(provider, rotatedModelId),
      };
    default: {
      provider satisfies never;
      return panic(`Unhandled provider: ${String(provider)}`);
    }
  }
};

const flagValue = (args: string[], flag: string): string | undefined => {
  const flagIndex = args.indexOf(flag);
  if (flagIndex === -1) {
    return undefined;
  }

  const value = args.at(flagIndex + 1);
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`Pass ${flag} followed by a value.`);
  }

  return value;
};

const parseProvider = (args: string[]): CanaryProvider => {
  const value = flagValue(args, "--provider");
  switch (value) {
    case "google":
    case "openrouter":
    case "openai":
    case "anthropic":
    case "bedrock":
    case "mistral":
      return value;
    case undefined:
      break;
  }

  throw new TypeError(
    `Pass --provider followed by one of: ${CANARY_PROVIDERS.join(", ")}.`,
  );
};

type CanaryRunArgs =
  | { provider: CanaryProvider; tier: "daily" }
  | { provider: CanaryProvider; rotationIndex: number; tier: "weekly" };

const parseCanaryRunArgs = (args: string[]): CanaryRunArgs => {
  const provider = parseProvider(args);
  const tierValue = flagValue(args, "--tier") ?? "daily";
  if (tierValue === "daily") {
    return { provider, tier: "daily" };
  }
  if (tierValue !== "weekly") {
    throw new TypeError(
      `Pass --tier followed by one of: ${CANARY_TIERS.join(", ")}.`,
    );
  }

  const rotationValue = flagValue(args, "--rotation-index");
  const rotationIndex =
    rotationValue === undefined
      ? Math.floor(Date.now() / MILLISECONDS_PER_WEEK)
      : Number(rotationValue);
  if (!Number.isSafeInteger(rotationIndex) || rotationIndex < 0) {
    throw new TypeError(
      "Pass --rotation-index followed by a non-negative integer.",
    );
  }

  return { provider, rotationIndex, tier: "weekly" };
};

export const errorSummary = (error: unknown, signal: AbortSignal): string => {
  if (signal.aborted) {
    return "timeout";
  }

  if (classifyCanaryFailure(error).kind === "credential-rejected") {
    return "credential rejected";
  }

  const rejection = providerRejectionReason(error);
  if (rejection !== null) {
    return `provider rejected request (${rejection})`;
  }

  if (error instanceof CanaryProviderRunError) {
    if (error.status !== null) {
      return withProviderCode(`provider HTTP ${error.status}`, error.code);
    }
    const stage = error.stage.replaceAll("-", " ");
    if (error.code === null) {
      return `provider stream error ${stage}`;
    }
    const detail =
      error.incompleteReason === null
        ? error.code
        : `${error.code}: ${error.incompleteReason}`;
    return `provider stream error ${stage} (${detail})`;
  }

  if (
    error instanceof TypeError &&
    SAFE_CANARY_ERROR_MESSAGES.has(error.message)
  ) {
    return error.message;
  }

  const evidence = providerEvidence(error);
  const status = providerStatus(evidence);
  return withProviderCode(
    status === null ? "provider error" : `provider HTTP ${status}`,
    safeProviderCode(rawProviderCode(evidence)),
  );
};

const withProviderCode = (summary: string, code: string | null): string =>
  code === null ? summary : `${summary} (${code})`;

const probeLabel = (context: CanaryContext, probe: Probe): string => {
  if (probe.type === "capability") {
    return probe.name;
  }

  const modelId =
    probe.type === "model-role" && probe.role === "pdf"
      ? pdfCanarySelection(context.provider)?.modelId
      : DEFAULT_MODELS[context.provider][probe.role];
  const prefix =
    probe.type === "structured-output-role" ? "structured-role" : "role";
  return `${prefix}-${probe.role}:${modelId ?? "unsupported"}`;
};

const attemptSummary = (attempts: number): string =>
  attempts === 1 ? "" : ` after ${attempts} attempts`;

type RecordProbeResultOptions = {
  label: string;
  provider: CanaryProvider;
  result: CanaryProbeResult;
};

const recordProbeResult = ({
  label,
  provider,
  result,
}: RecordProbeResultOptions): number => {
  if (result.status === "passed") {
    console.log(
      `[ai-canary] ${provider}/${label}: passed${attemptSummary(result.attempts)}`,
    );
    return 0;
  }

  console.error(
    `[ai-canary] ${provider}/${label}: failed${attemptSummary(result.attempts)} (${errorSummary(result.error, result.signal)})`,
  );
  return 1;
};

type CanaryProbeRun = {
  label: string;
  run: (signal: AbortSignal) => Promise<void>;
  timeoutMs: number;
};

type RunCanaryProbeSequenceOptions = {
  index?: number;
  probeRuns: readonly CanaryProbeRun[];
  provider: CanaryProvider;
  runProbe?: (options: RunCanaryProbeOptions) => Promise<CanaryProbeResult>;
};

// A credential rejected by the very first probe rejects every later probe too:
// abort so the run reports a rotation task instead of a capability regression.
export const runCanaryProbeSequence = async ({
  index = 0,
  probeRuns,
  provider,
  runProbe = runCanaryProbe,
}: RunCanaryProbeSequenceOptions): Promise<number> => {
  const probeRun = probeRuns.at(index);
  if (!probeRun) {
    return 0;
  }

  const { label, run, timeoutMs } = probeRun;
  const result = await runProbe({ run, timeoutMs });
  const failures = recordProbeResult({ label, provider, result });
  if (index === 0 && result.status === "failed") {
    const failure = classifyCanaryFailure(result.error);
    if (failure.kind === "credential-rejected") {
      throw new CanaryCredentialRejectedError({
        label,
        provider,
        reason: failure.reason,
      });
    }
  }

  const remaining = await runCanaryProbeSequence({
    index: index + 1,
    probeRuns,
    provider,
    runProbe,
  });
  return failures + remaining;
};

const run = async (): Promise<void> => {
  const args = parseCanaryRunArgs(Bun.argv.slice(2));
  const { provider } = args;
  const apiKey = process.env["AI_CANARY_API_KEY"];
  if (!apiKey) {
    throw new TypeError(`No canary credential is configured for ${provider}.`);
  }

  const context = {
    config: createCanaryConfig({ apiKey, provider }),
    provider,
  } satisfies CanaryContext;
  let failures = await runCanaryProbeSequence({
    probeRuns: canaryProbeRuns(context),
    provider,
  });
  failures = await runCatalogCanaryProbes({ apiKey, provider }, failures);

  if (args.tier === "weekly") {
    const rotation = weeklyCanaryRotation({
      provider,
      rotationIndex: args.rotationIndex,
    });
    const weeklyContext = {
      ...context,
      rotatedConfig: createCanaryConfig({
        apiKey,
        provider,
        rotatedModelId: rotation.modelId,
      }),
      rotation,
    } satisfies WeeklyCanaryContext;
    console.log(
      `[ai-canary] ${provider}/weekly-rotation-${rotation.rotationIndex}: ` +
        `${rotation.modelId}, roles=${rotation.modelRoles.join(",")}, ` +
        `tool-shape=${rotation.toolShape}`,
    );
    failures = await runWeeklyCanaryProbes(weeklyContext, failures);
  }

  if (failures > 0) {
    throw new TypeError(
      `${failures} provider capability probe${failures === 1 ? "" : "s"} failed.`,
    );
  }
};

const isSkippedProbe = (context: CanaryContext, probe: Probe): boolean => {
  if (probe.type === "capability") {
    return false;
  }

  return probe.type === "model-role" && probe.role === "pdf"
    ? pdfCanarySelection(context.provider) === null
    : !isBYOKProviderRoleSupported({
        provider: context.provider,
        role: probe.role,
      });
};

const canaryProbeRuns = (context: CanaryContext): CanaryProbeRun[] => {
  const probeRuns: CanaryProbeRun[] = [];
  for (const probe of probes) {
    const label = probeLabel(context, probe);
    if (isSkippedProbe(context, probe)) {
      console.log(
        `[ai-canary] ${context.provider}/${label}: skipped (unsupported role)`,
      );
      continue;
    }
    probeRuns.push({
      label,
      run: async (signal) => {
        await probe.run(context, signal);
      },
      timeoutMs: probe.timeoutMs,
    });
  }
  return probeRuns;
};

type RunCatalogModelProbeOptions = {
  apiKey: string;
  modelId: string;
  provider: CanaryProvider;
  signal: AbortSignal;
};

// One minimal generation through the same resolution path the app uses, so
// the probe fails exactly when a user selecting this id would.
const runCatalogModelProbe = async ({
  apiKey,
  modelId,
  provider,
  signal,
}: RunCatalogModelProbeOptions): Promise<void> => {
  const config = createCanaryConfig({
    apiKey,
    provider,
    rotatedModelId: modelId,
  });
  const model = resolveTanStackTextModel({
    organizationId: null,
    orgAIConfig: config,
    role: CATALOG_PROBE_ROLE,
  });
  if (model.provider !== provider || model.modelId !== modelId) {
    throw new TypeError("Canary resolved an unexpected catalog model.");
  }

  const output = await generateTanStackTextForRole({
    abortSignal: signal,
    caching: NO_CACHING,
    finishPolicy: CANARY_TEXT_FINISH_POLICY,
    maxOutputTokens: modelRoleMaxOutputTokens({
      modelId,
      role: CATALOG_PROBE_ROLE,
    }),
    prompt: SYNTHETIC_PROMPT,
    organizationId: null,
    orgAIConfig: config,
    role: CATALOG_PROBE_ROLE,
    serviceTier: "standard",
    tenantWorkspaceIds: NO_TENANT_SCOPE,
  });
  requireNonEmptyText(output);
};

type RunCatalogCanaryProbesOptions = {
  apiKey: string;
  provider: CanaryProvider;
  /** Seam for tests: the per-model probe. */
  probeModel?: (options: RunCatalogModelProbeOptions) => Promise<void>;
  /** Seam for tests: the sweep clock. */
  now?: () => number;
  runProbe?: (options: RunCanaryProbeOptions) => Promise<CanaryProbeResult>;
};

export class CanaryCatalogSweepBudgetError extends TaggedError(
  "CanaryCatalogSweepBudgetError",
)<{ message: string; modelId: string }> {}

export const runCatalogCanaryProbes = async (
  {
    apiKey,
    provider,
    probeModel = runCatalogModelProbe,
    now = () => Date.now(),
    runProbe = runCanaryProbe,
  }: RunCatalogCanaryProbesOptions,
  failures: number,
): Promise<number> => {
  let totalFailures = failures;
  const deadline = now() + CATALOG_SWEEP_BUDGET_MS;
  for (const modelId of catalogModelIds(provider)) {
    const label = `catalog:${modelId}`;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      totalFailures += recordProbeResult({
        label,
        provider,
        result: {
          attempts: 0,
          error: new CanaryCatalogSweepBudgetError({
            message: "catalog sweep budget exhausted before this id was probed",
            modelId,
          }),
          signal: new AbortController().signal,
          status: "failed",
        },
      });
      continue;
    }
    const result = await runProbe({
      run: async (signal) => {
        await probeModel({ apiKey, modelId, provider, signal });
      },
      timeoutMs: Math.min(MODEL_ROLE_PROBE_TIMEOUT_MS, remainingMs),
    });
    totalFailures += recordProbeResult({ label, provider, result });
  }
  return totalFailures;
};

const runWeeklyCanaryProbes = async (
  context: WeeklyCanaryContext,
  failures: number,
): Promise<number> => {
  let totalFailures = failures;

  for (const role of context.rotation.modelRoles) {
    const label = `weekly-role-${role}:${context.rotation.modelId}`;
    const result = await runCanaryProbe({
      run: async (signal) => {
        await runWeeklyModelRoleProbe({ context, role, signal });
      },
      timeoutMs: MODEL_ROLE_PROBE_TIMEOUT_MS,
    });
    totalFailures += recordProbeResult({
      label,
      provider: context.provider,
      result,
    });

    const structuredLabel = `weekly-structured-role-${role}:${context.rotation.modelId}`;
    const structuredResult = await runCanaryProbe({
      run: async (signal) => {
        await runWeeklyStructuredOutputModelRoleProbe({
          context,
          role,
          signal,
        });
      },
      timeoutMs: MODEL_ROLE_PROBE_TIMEOUT_MS,
    });
    totalFailures += recordProbeResult({
      label: structuredLabel,
      provider: context.provider,
      result: structuredResult,
    });
  }

  const label = `weekly-tool-${context.rotation.toolShape}:${context.rotation.modelId}`;
  const result = await runCanaryProbe({
    run: async (signal) => {
      await runWeeklyToolShapeProbe({ context, signal });
    },
    timeoutMs: TOOL_ROUND_TRIP_PROBE_TIMEOUT_MS,
  });
  return (
    totalFailures +
    recordProbeResult({ label, provider: context.provider, result })
  );
};

if (import.meta.main) {
  await run().catch((error: unknown) => {
    // Never print provider errors: bodies can echo request content or headers.
    const message =
      error instanceof TypeError ? error.message : "Canary failed.";
    console.error(`[ai-canary] ${message}`);
    process.exitCode = 1;
  });
}
