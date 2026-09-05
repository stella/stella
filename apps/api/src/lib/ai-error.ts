import { panic, Result } from "better-result";

/**
 * Stable, user-facing classification of AI provider errors.
 *
 * The `AIErrorKind` strings cross the network as the chat
 * stream's error message; the frontend maps them to i18n keys.
 * The wire values live in @stll/api-contract so producers and consumers are
 * checked against one source.
 */
import { AI_ERROR_KINDS, type AIErrorKind } from "@stll/api-contract";

import {
  AIGenerationCancelledError,
  ChatEmptyCompletionError,
  ChatLoopDetectedError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import type {
  ChatTerminalError,
  HandlerErrorStatusCode,
} from "@/api/lib/errors/tagged-errors";

export { AI_ERROR_KINDS };
export type { AIErrorKind };

const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_STATUS_STRING_PATTERN = /^[1-5]\d{2}$/u;

// TanStack preserves these provider-owned response-body values when an adapter
// cannot preserve the numeric status itself (notably OpenAI's 401 response).
const PROVIDER_CREDENTIAL_REJECTION_MARKERS = new Set([
  "authentication_error",
  "invalid_api_key",
]);

const hasProviderCredentialRejectionMarker = (value: unknown): boolean =>
  typeof value === "string" && PROVIDER_CREDENTIAL_REJECTION_MARKERS.has(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const isHttpStatus = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= HTTP_STATUS_MIN &&
  value <= HTTP_STATUS_MAX;

const httpStatusFromString = (value: unknown): number | null => {
  if (typeof value !== "string" || !HTTP_STATUS_STRING_PATTERN.test(value)) {
    return null;
  }
  const status = Number(value);
  return isHttpStatus(status) ? status : null;
};

const providerStatusCode = (error: unknown): number | null => {
  if (!isRecord(error)) {
    return null;
  }

  // A `HandlerError` answers with a status of this service's own: the AI stack
  // wraps a provider failure in a fixed 502 and keeps the provider's status in
  // `code`. Reading `status` off one names every wrapped failure by the
  // wrapper, so only the provider-owned fields below are read for it.
  if (!HandlerError.is(error)) {
    // Range-checked like the nested body fields below: an integer outside the
    // HTTP range is not a status, and treating one as one both mis-names the
    // failure (>= 500 would read as a provider outage) and puts a meaningless
    // number in the failure log.
    const statusCode = error["statusCode"];
    if (isHttpStatus(statusCode)) {
      return statusCode;
    }

    const status = error["status"];
    if (isHttpStatus(status)) {
      return status;
    }
  }

  // TanStack's RUN_ERROR contract carries `code` as a string. Its adapters
  // normalize a provider's numeric HTTP status to this field before the
  // exception crosses the stream boundary. Accept exactly a three-digit HTTP
  // code here; symbolic provider codes still need an explicit classification.
  const codeStatus = httpStatusFromString(error["code"]);
  if (codeStatus !== null) {
    return codeStatus;
  }

  // A provider response body nests the status one level down, as
  // `{ error: { code, message, status } }`, where `code` is the HTTP status and
  // `status` its symbolic name. Only an integer inside the HTTP range counts,
  // so a body whose `code` is symbolic ("insufficient_quota") or an
  // application error number still falls through to the cause walk.
  const body = error["error"];
  if (isRecord(body)) {
    const bodyStatus = body["status"];
    if (isHttpStatus(bodyStatus)) {
      return bodyStatus;
    }
    const bodyCode = body["code"];
    if (isHttpStatus(bodyCode)) {
      return bodyCode;
    }
  }

  return null;
};

const isProviderCredentialRejection = (error: unknown): boolean => {
  if (!isRecord(error)) {
    return false;
  }

  if (
    hasProviderCredentialRejectionMarker(error["code"]) ||
    hasProviderCredentialRejectionMarker(error["type"])
  ) {
    return true;
  }

  const body = error["error"];
  return (
    isRecord(body) &&
    (hasProviderCredentialRejectionMarker(body["code"]) ||
      hasProviderCredentialRejectionMarker(body["type"]))
  );
};

const isProviderError = (error: unknown): boolean =>
  isRecord(error) &&
  (providerStatusCode(error) !== null || isProviderCredentialRejection(error));

/**
 * The provider's structured error body, recovered from a stream error message.
 *
 * An adapter forwards that body as the run error's `rawEvent` only when the SDK
 * exception exposes one. An exception that carries the status as a plain field
 * and stringifies the response body into its message arrives with neither
 * `rawEvent` nor `code`, so an error rebuilt from the event holds no status at
 * all, and every failure from that provider (quota, billing, retired model and
 * outage alike) falls to `unknown`. Recover the body from the message when the
 * message is one, and hand it to the classifier as the failure's cause.
 *
 * Read for classification only and never logged: a provider message can echo
 * request content.
 */
export const providerErrorBody = (
  message: string,
): Record<string, unknown> | undefined => {
  // `JSON.parse` skips leading whitespace, so the guard must too; otherwise a
  // body an adapter passed through verbatim would be dropped over a newline.
  if (!message.trimStart().startsWith("{")) {
    return undefined;
  }
  const parsed = Result.try((): unknown => JSON.parse(message));
  if (Result.isError(parsed)) {
    return undefined;
  }
  return isRecord(parsed.value) ? parsed.value : undefined;
};

const errorCause = (error: unknown): unknown => {
  if (!isRecord(error)) {
    return undefined;
  }
  return error["cause"];
};

// The first provider status in the cause chain, walked exactly as
// `classifyAIError` walks it so the status a failure is logged with is the
// one the classifier judged it by.
const providerStatusCodeFromCauseChain = (error: unknown): number | null => {
  const seen = new Set<object>();
  let candidate = error;
  while (isRecord(candidate) && !seen.has(candidate)) {
    seen.add(candidate);
    const status = providerStatusCode(candidate);
    if (status !== null) {
      return status;
    }
    candidate = errorCause(candidate);
  }
  return null;
};

const classifyAIErrorInternal = (
  error: unknown,
  seen: Set<object>,
): AIErrorKind => {
  if (isRecord(error)) {
    if (seen.has(error)) {
      return "unknown";
    }
    seen.add(error);
  }

  if (ChatLoopDetectedError.is(error)) {
    return "loop_detected";
  }
  if (ChatEmptyCompletionError.is(error)) {
    return "empty_completion";
  }
  // TanStack wraps provider RUN_ERROR events in a 502 HandlerError. Preserve a
  // recognised provider cause so a permanent provider response does not look
  // like a transient transport outage.
  if (HandlerError.is(error) && error.cause !== undefined) {
    const causeKind = classifyAIErrorInternal(error.cause, seen);
    if (causeKind !== "unknown") {
      return causeKind;
    }
  }
  if (isProviderError(error)) {
    const statusCode = providerStatusCode(error);
    if (statusCode === 429) {
      return "quota_exhausted";
    }
    // A provider 402 is the upstream account's billing/credit problem,
    // distinct from Stella's own usage preflight, which returns a
    // structured 402 before the model call and never reaches this
    // classifier.
    if (statusCode === 402) {
      return "provider_billing";
    }
    // A provider 401 means it rejected the credentials it was called with:
    // the configured key is missing, revoked, or expired. Like a retired
    // model, that is a config problem an administrator has to fix, so
    // retrying won't help.
    //
    // Only a provider status or explicit provider-owned credential marker
    // counts, which is what keeps a 401 this service raised itself out of
    // here: its curated copy would otherwise be replaced by the provider's.
    // A provider 403 stays unmapped because it is ambiguous (permission,
    // region, or account state) where a 401 is not.
    if (
      statusCode === 401 ||
      (statusCode === null && isProviderCredentialRejection(error))
    ) {
      return "provider_credentials_rejected";
    }
    // A 404 on a generate/stream call means the provider no longer
    // serves the configured model (retired or renamed upstream) — a
    // config problem, not a transient outage, so retrying won't help.
    if (statusCode === 404) {
      return "model_unavailable";
    }
    if (statusCode !== null && statusCode >= HTTP_SERVER_ERROR_MIN) {
      return "provider_unavailable";
    }
  }
  // Walk through any wrapper that carries the original provider error
  // on `cause` (e.g. our own `WorkflowIntegrationError`, or generic
  // `Error.cause` from a higher-level rethrow). Without this, callers
  // that pass a wrapped error get classified as `unknown` and miss the
  // mapped HTTP status / UX copy.
  const cause = errorCause(error);
  if (cause !== undefined) {
    return classifyAIErrorInternal(cause, seen);
  }
  return "unknown";
};

export const classifyAIError = (error: unknown): AIErrorKind =>
  classifyAIErrorInternal(error, new Set<object>());

/**
 * The provider HTTP status a failure carries, as fingerprint fields.
 *
 * `classifyAIError` names most provider failures from this status. Some
 * adapters preserve only an explicit provider-owned credential marker; those
 * are named without inventing a status. For an unknown failure, the status is
 * what separates "the provider answered with a status this code does not map"
 * from "the failure carried no status at all". A failure sink needs that
 * distinction: an adapter forwards the provider's structured error body as a
 * plain object rather than an `Error`, and `errorFingerprint` reduces any
 * non-`Error` to a bare `UnknownError`, leaving the two indistinguishable in
 * the log.
 *
 * The walk mirrors `classifyAIError`'s: a status reached only through a
 * wrapper's `cause` is the same evidence, and reading just the outer error
 * would report nothing for the shapes the classifier looked hardest at. A
 * status found here is always one the classifier could not map, because a
 * mapped one makes the failure anticipated and it is never logged.
 *
 * An integer status is structural, so it ships under the same non-PII
 * contract as `error.class`. The body it was read from is never logged: a
 * provider message can echo request content. The key avoids the logger's
 * redaction regex so it survives `sanitizeLogAttributes`.
 */
export const providerStatusFields = (
  error: unknown,
): Record<string, string> => {
  const status = providerStatusCodeFromCauseChain(error);
  return status === null ? {} : { "error.provider.status": String(status) };
};

// Total over `ChatTerminalError`, so a new terminal outcome cannot be added to
// that union without deciding how a failure sink grades it. Each guard is
// wrapped because `is` reads the class off its receiver.
const CHAT_TERMINAL_ERROR_GUARDS = {
  ChatEmptyCompletionError: (error: unknown) =>
    ChatEmptyCompletionError.is(error),
  ChatLoopDetectedError: (error: unknown) => ChatLoopDetectedError.is(error),
} as const satisfies Record<
  ChatTerminalError["_tag"],
  (error: unknown) => boolean
>;

const isChatTerminalError = (error: unknown): boolean =>
  Object.values(CHAT_TERMINAL_ERROR_GUARDS).some((is) => is(error));

// The generation helper reports a cancelled run as the 502 its callers answer
// with and records the outcome on the cause, so the tag is read one level down
// as well as at the top. The walk stops there: a cancellation is only this
// helper's own, and reading the whole chain would also name a run that failed
// on a provider error while a later cancellation was in flight.
const isCancelledGeneration = (error: unknown): boolean =>
  AIGenerationCancelledError.is(error) ||
  (HandlerError.is(error) && AIGenerationCancelledError.is(error.cause));

/**
 * Whether a failure is one this service anticipated, so a telemetry sink can
 * record it as an operational state rather than a defect.
 *
 * A named kind is anticipated by construction. So is a `HandlerError` below
 * 500: the AI stack raises those itself, with curated user-facing copy, for a
 * configuration state the caller can act on (no key for the role, 403; a
 * provider or model that does not serve it, 400). They are invisible to
 * `classifyAIError`, which names failures from provider HTTP statuses and
 * explicit provider-owned markers, and a status this service chose is neither:
 * such a refusal falls through to `unknown`, "a shape this code does not
 * anticipate", the exact opposite of what it is.
 *
 * A `ChatTerminalError` is invisible to the classifier for the same reason,
 * and carries no status at all to fall back on: the chat stream constructs it
 * for an outcome it models and recovers from, so it is anticipated whatever
 * kind it classifies as. `ChatLoopDetectedError` already reaches
 * `loop_detected`; without the union, its sibling empty completion would be
 * the one modelled outcome graded as a defect.
 *
 * The request layer already draws this line: `runSafeHandler` reports a
 * handler failure from 500 up and answers a 4xx as an ordinary response.
 *
 * A cancelled generation is the one self-raised outcome that line cannot
 * place. The generation helper rejects a run whose caller-supplied abort
 * signal fired, which is a deadline that caller set or a client that went
 * away, but it answers 502, so the status test reads it as a defect. It is
 * recognised by its cause instead, the tag the helper attaches for exactly
 * this, so the 502 the caller receives stays unchanged.
 */
export const isAnticipatedAIFailure = (
  error: unknown,
  kind: AIErrorKind,
): boolean =>
  kind !== "unknown" ||
  isChatTerminalError(error) ||
  isCancelledGeneration(error) ||
  (HandlerError.is(error) && error.status < HTTP_SERVER_ERROR_MIN);

type AIHandlerErrorFallback = {
  status: HandlerErrorStatusCode;
  message: string;
};

/**
 * Build a `HandlerError` for an AI provider failure.
 *
 * For known AI failure modes (quota, usage limits, transient
 * upstream outage) returns a typed error with an actionable
 * status + message. For everything else, returns the caller's
 * fallback so unrelated bugs aren't masked as "AI unavailable".
 */
export const aiHandlerError = (
  error: unknown,
  fallback: AIHandlerErrorFallback,
): HandlerError => {
  const kind = classifyAIError(error);
  switch (kind) {
    case "quota_exhausted":
      return new HandlerError({
        status: 429,
        message:
          "The AI provider's quota is exhausted. Try again shortly, or contact your workspace admin.",
        cause: error,
      });
    case "provider_billing":
      return new HandlerError({
        status: 402,
        message:
          "The AI provider reported a billing or credit problem. An administrator should check the provider account.",
        cause: error,
      });
    case "provider_credentials_rejected":
      return new HandlerError({
        status: 502,
        message:
          "The AI provider rejected the configured credentials. An administrator should check the provider API key in organization settings.",
        cause: error,
      });
    case "model_unavailable":
      return new HandlerError({
        status: 502,
        message:
          "The configured AI model is no longer available from the provider. An administrator should update the model in organization settings.",
        cause: error,
      });
    case "provider_unavailable":
      return new HandlerError({
        status: 502,
        message:
          "The AI provider is temporarily unavailable. Please try again in a moment.",
        cause: error,
      });
    case "loop_detected":
      return new HandlerError({
        status: 502,
        message:
          "The AI model repeated the same work and could not recover. Please try again with a narrower request.",
        cause: error,
      });
    case "empty_completion":
      return new HandlerError({
        status: 502,
        message:
          "The AI model returned an empty reply. Please try again, or rephrase the request.",
        cause: error,
      });
    case "unknown":
      return new HandlerError({ ...fallback, cause: error });
    default: {
      kind satisfies never;
      return panic(`Unhandled kind: ${String(kind)}`);
    }
  }
};

type AIErrorStatusBody = {
  status: HandlerErrorStatusCode;
  body: { message: string };
};

/**
 * Variant of `aiHandlerError` for handlers that build an Elysia
 * `status()` response directly instead of returning `HandlerError`.
 * Returns `{ status, body }` so callers can spread it into
 * `status(status, body)`.
 */
export const aiErrorStatusBody = (
  error: unknown,
  fallback: { status: HandlerErrorStatusCode; message: string },
): AIErrorStatusBody => {
  const handlerError = aiHandlerError(error, fallback);
  return {
    status: handlerError.status,
    body: { message: handlerError.message },
  };
};
