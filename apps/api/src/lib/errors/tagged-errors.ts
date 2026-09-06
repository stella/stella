import { panic, TaggedError } from "better-result";

import type { PersistedAstDegradation } from "@stll/legal-ast/document-ast";

export { FetchBoundaryError } from "@stll/errors";

export type HandlerErrorStatusCode =
  | 400
  | 401
  | 402
  | 403
  | 404
  | 409
  | 413
  | 422
  | 428
  | 429
  | 500
  | 502
  | 503;

export type HandlerErrorCode = string;

/**
 * Structured 402 usage-limit detail surfaced alongside the message so the
 * frontend renders an "x of y units left" modal without parsing the text.
 * Only the usage-limit preflight populates these; every other `HandlerError`
 * leaves them unset and `safeErrorBody` omits them.
 */
export type HandlerErrorUsageDetail = {
  reason: UsageLimitExceededReason;
  required: number;
  available: number;
};

/**
 * Structured 409 detail for a queued run whose estimated consumption
 * crosses the confirmation threshold: the client re-submits the same
 * request with `confirmedUnits >= estimatedUnits` to proceed. Distinct
 * from `usage` (the 402 over-limit detail) — this is not an over-limit
 * state, and the run may well be affordable. Answered as a 428, never a
 * 409: run initiators already use 409 for "a run is active on this
 * document", and clients resolve that by attaching the existing run.
 */
export type HandlerErrorConfirmationDetail = {
  estimatedUnits: number;
  availableUnits: number;
};

/**
 * Ceremony fields of an agent-auth ID-JAG `interaction_required` step-up: a
 * human must complete the RFC 8628-style claim ceremony before a first
 * `(iss, sub)` delegation is written. The pinned guide reserves `claim` for
 * these ceremony fields only; the registration handles ride at the top level
 * via {@link HandlerErrorStepUp}, mirroring the `service_auth` registration
 * envelope so an agent parses both responses with one shape.
 */
export type HandlerErrorClaim = {
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

/**
 * Top-level step-up handles paired with {@link HandlerErrorClaim} on an
 * agent-auth ID-JAG `interaction_required`: the registration id, its identity
 * type, the claim ceremony endpoint, the claim token plus its absolute
 * expiry, and the scopes granted once the ceremony completes.
 */
export type HandlerErrorStepUp = {
  registration_id: string;
  registration_type: string;
  claim_url: string;
  claim_token: string;
  claim_token_expires: string;
  post_claim_scopes: string[];
};

/**
 * One required template field a fill rejected for being omitted or left
 * empty. Structurally mirrors `MissingRequiredField`
 * (`lib/templates/template-optional-defaults.ts`) rather than importing it,
 * so this foundational error module carries no dependency on that
 * feature-specific one; every fill route that populates
 * {@link HandlerErrorProps.requiredFields} passes that same shape through
 * unchanged.
 */
export type HandlerErrorMissingRequiredField = {
  path: string;
  label: string | null;
  inputType: string;
  options: string[] | null;
};

/**
 * One field-level reason a request was rejected: the dot path of the offending
 * input (`fields.2`) and what is wrong with it. Structurally mirrors the MCP
 * envelope's issue shape rather than importing it, so this foundational module
 * stays free of transport dependencies.
 */
export type HandlerErrorValidationIssue = {
  path: string;
  message: string;
};

export type HandlerErrorProps<
  TStatus extends HandlerErrorStatusCode = HandlerErrorStatusCode,
> = {
  code?: HandlerErrorCode | undefined;
  status: TStatus;
  message: string;
  /**
   * OAuth-style machine-readable error identifier (e.g. `login_required`,
   * `interaction_required`, `issuer_not_enabled`). Distinct from `code`
   * (the internal chat-transport vocabulary); surfaced verbatim on the
   * response body for agent clients that branch on the error.
   */
  error?: string | undefined;
  /** Step-up ceremony fields for an ID-JAG `interaction_required`. */
  claim?: HandlerErrorClaim | undefined;
  /** Top-level step-up handles paired with `claim` on `interaction_required`. */
  stepUp?: HandlerErrorStepUp | undefined;
  cause?: unknown;
  usage?: HandlerErrorUsageDetail | undefined;
  confirmation?: HandlerErrorConfirmationDetail | undefined;
  /** Every required field a rejected fill was missing, in full (path, label,
   *  input type, options) — not reduced to a message — so a client can
   *  render the right control per field and retry with all of them at once. */
  requiredFields?: HandlerErrorMissingRequiredField[] | undefined;
  /** Every input entry a validation rejection found fault with, by its dot
   *  path, so a caller can fix the exact entries it sent rather than parsing
   *  the summary message. */
  issues?: HandlerErrorValidationIssue[] | undefined;
};

// TaggedError(...) cannot reference the class type parameter in the base
// expression, so the base uses the wide props type and the subclass narrows
// `status` back down for callers.
export class HandlerError<
  TStatus extends HandlerErrorStatusCode = HandlerErrorStatusCode,
> extends TaggedError("HandlerError")<HandlerErrorProps> {
  declare code?: HandlerErrorCode | undefined;
  declare status: TStatus;
  declare usage?: HandlerErrorUsageDetail | undefined;
  declare confirmation?: HandlerErrorConfirmationDetail | undefined;
  declare error?: string | undefined;
  declare claim?: HandlerErrorClaim | undefined;
  declare stepUp?: HandlerErrorStepUp | undefined;
  declare requiredFields?: HandlerErrorMissingRequiredField[] | undefined;
  declare issues?: HandlerErrorValidationIssue[] | undefined;

  constructor(props: HandlerErrorProps<TStatus>) {
    super(props);
    this.code = props.code;
    this.status = props.status;
    this.usage = props.usage;
    this.confirmation = props.confirmation;
    this.error = props.error;
    this.claim = props.claim;
    this.stepUp = props.stepUp;
    this.requiredFields = props.requiredFields;
    this.issues = props.issues;
  }
}

export class DatabaseError extends TaggedError("DatabaseError")<{
  code?: string | undefined;
  message: string;
  cause?: unknown;
}> {}

export class DatabaseRlsError extends TaggedError("DatabaseRlsError")<{
  code?: string;
  message: string;
  cause?: unknown;
}> {}

export class Unreachable extends TaggedError("Unreachable")<{
  message: string;
}> {}

export const unreachable = (message: string): never => panic(message);

export class ParseXmlError extends TaggedError("ParseXmlError")<{
  message: string;
  cause: unknown;
}> {}

export class ConfigurationError extends TaggedError("ConfigurationError")<{
  message: string;
  cause?: unknown;
}> {}

export class TelemetryError extends TaggedError("TelemetryError")<{
  message: string;
  cause?: unknown;
}> {}

export const USAGE_LIMIT_EXCEEDED_REASONS = [
  "no_entitlement",
  "usage_limit_exceeded",
  "entitlement_inactive",
] as const;

export type UsageLimitExceededReason =
  (typeof USAGE_LIMIT_EXCEEDED_REASONS)[number];

export class UsageLimitExceededError extends TaggedError(
  "UsageLimitExceededError",
)<{
  message: string;
  required: number;
  available: number;
  reason: UsageLimitExceededReason;
}> {}

export class HealthCheckError extends TaggedError("HealthCheckError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * A Redis client was closed while a caller was waiting for it to connect.
 * The caller must not be handed that client: it belongs to a shutdown that
 * has already run, and the next caller builds a fresh one.
 */
export class RedisClientClosedError extends TaggedError(
  "RedisClientClosedError",
)<{
  message: string;
}> {}

/**
 * A legal-corpus object could not be read and the row carries no Postgres
 * copy to serve instead. Under canonical corpus storage (or after a column
 * trim) the object *is* the document, so an object-storage outage has to
 * surface as a failure rather than an empty body.
 */
/*
 * The public decision read is the one caller that contains this rather
 * than propagating it: it can answer "the document is not readable right
 * now" (`documentPending`) without claiming the decision has no body, so
 * failing there would drop the metadata, citations and case number for a
 * decision the reader could still recognise and cite. Every other caller
 * has no such third answer and must keep failing.
 */
export class CorpusPayloadUnavailableError extends TaggedError(
  "CorpusPayloadUnavailableError",
)<{
  message: string;
  documentId: string;
  key: string;
  cause?: unknown;
}> {}

/**
 * A stored document AST carried vocabulary this reader does not declare:
 * a block role, a block kind, or an inline kind. The read served the
 * document with those degraded (see `persistedAstDegradations` in
 * `@stll/legal-ast/document-ast`); this is telemetry only, so the row is
 * visible: either a writer newer than this reader, or a row written past
 * the ingestion boundary that needs repair.
 */
export class StoredAstDegradedError extends TaggedError(
  "StoredAstDegradedError",
)<{
  message: string;
  degradations: readonly PersistedAstDegradation[];
}> {}

/** Validation/domain-layer errors: no valid inputs, invalid config. */
export class WorkflowValidationError extends TaggedError(
  "WorkflowValidationError",
)<{
  message: string;
}> {}

/** Chat validation failure for tool inputs, outputs, or messages. */
export class ChatToolValidationError extends TaggedError(
  "ChatToolValidationError",
)<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Failure classes a chat tool error carries, driving orchestrator policy and
 * model guidance instead of relying on the model to parse prose:
 *  - `server-defect`: a Stella bug (backstop refusal, DB failure, broken
 *    invariant). The orchestrator refuses to re-dispatch the identical
 *    tool+args for the rest of the turn; retrying cannot help.
 *  - `invalid-input`: the call's arguments are wrong, conflict with current
 *    state, or target an object that cannot accept the operation (read-only);
 *    the model should correct the call.
 *  - `not-found`: the referenced object does not exist or is not accessible.
 *  - `unavailable`: the tool, feature, or permission is off on this surface or
 *    deployment; no argument change helps.
 *  - `limit`: a domain limit or entitlement was hit; the identical call will
 *    not succeed, a smaller/different one might.
 *  - `transient`: an external dependency failed; a retry may succeed.
 */
export const CHAT_TOOL_ERROR_KINDS = [
  "server-defect",
  "invalid-input",
  "not-found",
  "unavailable",
  "limit",
  "transient",
] as const;

export type ChatToolErrorKind = (typeof CHAT_TOOL_ERROR_KINDS)[number];

/** Chat tool execution failure. `kind` is required so every construction site
 * records an explicit retry-policy decision; see `CHAT_TOOL_ERROR_KINDS`. */
export class ChatToolError extends TaggedError("ChatToolError")<{
  kind: ChatToolErrorKind;
  message: string;
  cause?: unknown;
}> {}

/**
 * Chat stream finished with finish_reason=stop and zero output
 * tokens. Observed with small Gemini variants (notably 2.5-flash-lite)
 * on cached prefix replays. Surfaced as a tagged error for telemetry
 * so we can track which models cause it.
 */
export class ChatEmptyCompletionError extends TaggedError(
  "ChatEmptyCompletionError",
)<{
  message: string;
}> {}

/** Chat agent looped past the recovery budget. */
export class ChatLoopDetectedError extends TaggedError(
  "ChatLoopDetectedError",
)<{
  message: string;
}> {}

/**
 * Terminal outcomes the chat stream raises itself when a model attempt yields
 * no usable assistant turn: an outcome it models, not a shape it failed to
 * anticipate (an empty completion is even retried on the fallback model). A
 * consumer that grades a failure has to treat the whole union that way; see
 * `isAnticipatedAIFailure`.
 */
export type ChatTerminalError =
  | ChatEmptyCompletionError
  | ChatLoopDetectedError;

/**
 * A text generation ended because the abort signal its caller passed fired:
 * a deadline that caller set, or a client that went away mid-request.
 *
 * Carried as the `cause` of the 502 the generation helper answers with, so
 * the outcome stays identifiable after the status has been chosen. The status
 * cannot carry it: a caller-requested cancellation is an outcome the AI stack
 * models, but it is reported from 500 up, which is where a failure sink
 * otherwise reads "a shape this code did not anticipate".
 */
export class AIGenerationCancelledError extends TaggedError(
  "AIGenerationCancelledError",
)<{
  message: string;
}> {}

/** Sandbox execution failure: transpile, runtime, limit, or marshalling. */
export class SandboxError extends TaggedError("SandboxError")<{
  reason:
    | "transpile"
    | "forbidden-syntax"
    | "runtime"
    | "timeout"
    | "memory"
    | "host-call-limit"
    | "return-too-large"
    | "non-serialisable-return";
  message: string;
  /**
   * Console output captured before the failure, so callers can surface the
   * partial progress a failed run already made. Absent for failures that
   * happen before execution starts (transpile, forbidden-syntax).
   */
  logs?: readonly string[];
  cause?: unknown;
}> {}

/** Integration-layer errors: AI failures, parse failures, external I/O. */
export class WorkflowIntegrationError extends TaggedError(
  "WorkflowIntegrationError",
)<{
  message: string;
  cause?: unknown;
}> {}

/** Post-generation OOXML structural violations. */
export class OoxmlValidationError extends TaggedError("OoxmlValidationError")<{
  message: string;
  violations: {
    rule: string;
    message: string;
    element?: string;
  }[];
}> {}

/** Optimistic-lock failure inside a transaction. */
export class ConcurrentModificationError extends TaggedError(
  "ConcurrentModificationError",
)<{
  message: string;
}> {}

/** DOCX template block-directive structural errors. */
export class TemplateDirectiveError extends TaggedError(
  "TemplateDirectiveError",
)<{
  message: string;
  errors: {
    message: string;
    paragraphIndex: number;
    directive: string;
  }[];
}> {}

/** Case-law adapter page-fetch failure. */
export class AdapterFetchError extends TaggedError("AdapterFetchError")<{
  message: string;
  adapterKey: string;
  cursor: string | null;
  httpStatus?: number;
  cause?: unknown;
}> {}

/**
 * One source made no progress for a sustained run of ingestion cycles.
 * Captured once per stall episode; the per-cycle record lives in the
 * ingestion-events table and the structured logs.
 *
 * `code` carries the adapter key: capture suppression and issue grouping key
 * on class/code/frame and deliberately ignore context, so without it two
 * sources stalling inside one suppression window would collapse into a
 * single event while each loop's once-per-episode latch is already set,
 * leaving the second stall with no exception at all.
 */
export class IngestionStallError extends TaggedError("IngestionStallError")<{
  message: string;
  adapterKey: string;
  code: string;
  noProgressCycles: number;
}> {}

export const SUBPROCESS_TERMINATION_REASON = {
  timeout: "timeout",
  cancelled: "cancelled",
  crashed: "crashed",
  external: "external",
} as const;

export type SubprocessTerminationReason =
  (typeof SUBPROCESS_TERMINATION_REASON)[keyof typeof SUBPROCESS_TERMINATION_REASON];

type SubprocessTermination = {
  reason: SubprocessTerminationReason;
  signalCode: string;
};

/** Subprocess execution failure. */
export class SubprocessError extends TaggedError("SubprocessError")<{
  message: string;
  exitCode: number | null;
  termination: SubprocessTermination | null;
  cause?: unknown;
}> {}

export type ExtractionWorkerTermination = {
  reason: SubprocessTerminationReason;
  signalCode: string;
};

export const EXTRACTION_WORKER_ERROR_CODE = {
  cancelled: "worker_cancelled",
  crashed: "worker_crashed",
  external: "worker_externally_terminated",
  parser: "parser_failed",
  timeout: "worker_timeout",
} as const;

export type ExtractionWorkerErrorCode =
  (typeof EXTRACTION_WORKER_ERROR_CODE)[keyof typeof EXTRACTION_WORKER_ERROR_CODE];

const EXTRACTION_WORKER_TERMINATION_ERROR_CODE = {
  [SUBPROCESS_TERMINATION_REASON.cancelled]:
    EXTRACTION_WORKER_ERROR_CODE.cancelled,
  [SUBPROCESS_TERMINATION_REASON.crashed]: EXTRACTION_WORKER_ERROR_CODE.crashed,
  [SUBPROCESS_TERMINATION_REASON.external]:
    EXTRACTION_WORKER_ERROR_CODE.external,
  [SUBPROCESS_TERMINATION_REASON.timeout]: EXTRACTION_WORKER_ERROR_CODE.timeout,
} as const satisfies Record<
  SubprocessTerminationReason,
  ExtractionWorkerErrorCode
>;

export const extractionWorkerErrorCode = (
  termination: ExtractionWorkerTermination | null,
): ExtractionWorkerErrorCode =>
  termination === null
    ? EXTRACTION_WORKER_ERROR_CODE.parser
    : EXTRACTION_WORKER_TERMINATION_ERROR_CODE[termination.reason];

/** File content extraction failure. */
export class ExtractionWorkerError extends TaggedError(
  "ExtractionWorkerError",
)<{
  code: ExtractionWorkerErrorCode;
  message: string;
  exitCode: number | null;
  mimeType: string;
  sizeBytes: number;
  termination: ExtractionWorkerTermination | null;
}> {}

/** Timeout waiting for a readiness probe, subprocess, or external resource. */
export class TimeoutError extends TaggedError("TimeoutError")<{
  message: string;
  label: string;
  timeoutMs?: number;
  cause?: unknown;
}> {}

/**
 * A scheduler job exceeded its per-job execution ceiling. The task promise
 * cannot be cancelled, so the runner stops heartbeating, releases the lease,
 * and marks the run as timed out; a later "zombie" completion is rejected by
 * the guarded completion writes.
 */
export class SchedulerJobTimeoutError extends TaggedError(
  "SchedulerJobTimeoutError",
)<{
  message: string;
  jobId: string;
  timeoutMs: number;
}> {}

/**
 * One row of the file-derivative repair sweep could not be requeued. Wraps
 * the underlying failure so the capture carries a stable tag (a minified
 * constructor name identifies nothing) while the cause keeps the real frame.
 */
export class FileDerivativeRepairError extends TaggedError(
  "FileDerivativeRepairError",
)<{
  message: string;
  cause: unknown;
}> {}

/**
 * A persisted derivative state this build cannot judge: corrupt JSONB, or a
 * status written by a newer build. The repair sweep reports it and moves on
 * instead of retrying it or dying mid-scan.
 */
export class UnrecognizedDerivativeStateError extends TaggedError(
  "UnrecognizedDerivativeStateError",
)<{
  message: string;
}> {}
