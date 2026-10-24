import type { AIErrorKind, AIFailureCode } from "@stll/api-contract";
import { declareFailureClass } from "@stll/errors";

import { MANAGED_PROVIDER_UNAVAILABLE_CODE } from "@/api/lib/chat/provider-data-policy";
import {
  INCOMPLETE_STREAM_CODE,
  TRUNCATED_AT_OUTPUT_CEILING_CODE,
} from "@/api/lib/chat/provider-stream-contract";
import type { RedactedProviderDiagnostic } from "@/api/lib/errors/redacted-provider-diagnostic";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { HandlerErrorStatusCode } from "@/api/lib/errors/tagged-errors";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";

export const PROVIDER_CALL_ERROR_MESSAGE = "AI provider request failed";

export const MODEL_RUN_ERROR_MESSAGE = "AI model run failed";

/** The `code` for a provider value outside Stella's own codes. */
export const PROVIDER_ERROR_CODE = "provider_error";

/**
 * The codes a provider call error carries to HTTP bodies and telemetry. A
 * provider SDK `code` is arbitrary text (a gateway or BYOK endpoint chooses
 * it), so only Stella's own codes and the output-ceiling stop, which callers
 * treat as terminal, keep their value; the kind already carries the
 * classification.
 */
const PROVIDER_CALL_ERROR_CODES = [
  MANAGED_PROVIDER_UNAVAILABLE_CODE,
  INCOMPLETE_STREAM_CODE,
  TRUNCATED_AT_OUTPUT_CEILING_CODE,
  PROVIDER_ERROR_CODE,
] as const;

export type ProviderCallErrorCode = (typeof PROVIDER_CALL_ERROR_CODES)[number];

const isProviderCallErrorCode = (code: string): code is ProviderCallErrorCode =>
  PROVIDER_CALL_ERROR_CODES.some((known) => known === code);

export const providerCallErrorCode = (
  code: string | undefined,
): ProviderCallErrorCode | undefined => {
  if (code === undefined) {
    return undefined;
  }
  return isProviderCallErrorCode(code) ? code : PROVIDER_ERROR_CODE;
};

type ProviderCallErrorOptions = {
  model: Pick<ResolvedTanStackTextModel, "provider" | "keySource">;
  status: HandlerErrorStatusCode;
  code?: ProviderCallErrorCode | AIFailureCode | undefined;
  kind: AIErrorKind;
  facts?: { status: number; isRetryable?: boolean } | undefined;
  requestId?: string | undefined;
  providerDiagnostic?: RedactedProviderDiagnostic | undefined;
  /** How long the provider asked to wait before a retry, when it said. */
  retryAfterMs?: number | undefined;
};

const diagnostics = new WeakMap<
  ProviderCallError,
  RedactedProviderDiagnostic
>();

export class ProviderCallError extends HandlerError {
  declare code?: ProviderCallErrorCode | AIFailureCode | undefined;
  readonly provider: ResolvedTanStackTextModel["provider"];
  readonly keySource: ResolvedTanStackTextModel["keySource"];
  readonly providerStatus: number | undefined;
  readonly requestId: string | undefined;
  readonly kind: AIErrorKind;
  readonly retryAfterMs: number | undefined;

  get providerDiagnostic(): RedactedProviderDiagnostic | undefined {
    return diagnostics.get(this);
  }

  constructor({
    model,
    status,
    code,
    kind,
    facts,
    requestId,
    providerDiagnostic,
    retryAfterMs,
  }: ProviderCallErrorOptions) {
    super({
      message: PROVIDER_CALL_ERROR_MESSAGE,
      status,
      code,
      ...(facts === undefined
        ? {}
        : {
            cause: {
              status: facts.status,
              ...(facts.isRetryable === undefined
                ? {}
                : { isRetryable: facts.isRetryable }),
            },
          }),
    });
    if (providerDiagnostic !== undefined) {
      diagnostics.set(this, providerDiagnostic);
    }
    this.name = "ProviderCallError";
    this.provider = model.provider;
    this.keySource = model.keySource;
    this.providerStatus = facts?.status;
    this.requestId = requestId;
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * How a model run ended, as a failure records it for telemetry. `finish` is
 * the finish the run was graded by (`unfinished` when the stream ended
 * without one), and `providerStopReason` the stop reason the provider
 * reported, when its table lists it (`provider-stop-reasons.ts`).
 */
export type ModelRunFinish = {
  finish:
    "content_filter" | "length" | "none" | "stop" | "tool_calls" | "unfinished";
  providerStopReason?: string | undefined;
};

type ModelRunErrorOptions = {
  model: Pick<ResolvedTanStackTextModel, "provider" | "keySource">;
  /** The finish the run ended with, where one was observed. */
  finish?: ModelRunFinish | undefined;
};

/**
 * A model run that failed without a provider answer to name: the engine could
 * not parse or validate the structured output, or a library threw while the
 * run was in flight. Those messages quote model output, so the error owns a
 * fixed message and keeps no cause.
 */
export class ModelRunError extends HandlerError {
  readonly provider: ResolvedTanStackTextModel["provider"];
  readonly keySource: ResolvedTanStackTextModel["keySource"];
  readonly finish: ModelRunFinish | undefined;

  constructor(
    { model, finish }: ModelRunErrorOptions,
    message: string = MODEL_RUN_ERROR_MESSAGE,
  ) {
    super({ message, status: 502 });
    this.name = "ModelRunError";
    this.provider = model.provider;
    this.keySource = model.keySource;
    this.finish = finish;
  }
}

export const MODEL_OUTPUT_INCOMPLETE_MESSAGE =
  "The AI model's answer was cut off before it was complete";

/**
 * The model's answer ended before it was whole: the run stopped at its output
 * budget (a `length` finish, a `max_tokens` stop), or the structured output it
 * produced was cut off and does not parse. Named rather than left a bare
 * `ModelRunError`, so every sink records it as the incomplete answer it is and
 * a caller can tell the user so.
 */
export class ModelOutputIncompleteError extends ModelRunError {
  static {
    declareFailureClass(this, "model_output_incomplete");
  }

  constructor(options: ModelRunErrorOptions) {
    super(options, MODEL_OUTPUT_INCOMPLETE_MESSAGE);
    this.name = "ModelOutputIncompleteError";
  }
}

const MODEL_OUTPUT_MODERATED_MESSAGE =
  "The AI provider stopped the answer under its content policy";

/**
 * The provider filtered the model's answer (a `content_filter` finish): the
 * provider's policy decision, not a fault of this service, and not an answer
 * a caller can use.
 */
export class ModelOutputModeratedError extends ModelRunError {
  static {
    declareFailureClass(this, "model_output_moderated");
  }

  constructor(options: ModelRunErrorOptions) {
    super(options, MODEL_OUTPUT_MODERATED_MESSAGE);
    this.name = "ModelOutputModeratedError";
  }
}

const MODEL_RUN_UNFINISHED_MESSAGE =
  "The AI model ended its run without an answer";

/**
 * A text run that ended without a finished answer: it stopped to call a tool
 * the run did not offer, its provider reported no finish, or its stream
 * closed before the finish. The provider stopped short of an answer, so it is
 * graded as an incomplete provider stream.
 */
export class ModelRunUnfinishedError extends ModelRunError {
  static {
    declareFailureClass(this, "provider_stream_incomplete");
  }

  constructor(options: ModelRunErrorOptions) {
    super(options, MODEL_RUN_UNFINISHED_MESSAGE);
    this.name = "ModelRunUnfinishedError";
  }
}

const MODEL_OUTPUT_INVALID_MESSAGE =
  "The AI model's answer did not match the requested structure";

/**
 * A complete structured answer the requested schema rejects. The schema's own
 * issue text can quote the answer, so like its parent it keeps a fixed
 * message and no cause.
 */
export class ModelOutputInvalidError extends ModelRunError {
  static {
    declareFailureClass(this, "model_output_invalid");
  }

  constructor(options: ModelRunErrorOptions) {
    super(options, MODEL_OUTPUT_INVALID_MESSAGE);
    this.name = "ModelOutputInvalidError";
  }
}

const MODEL_DEADLINE_EXCEEDED_MESSAGE =
  "The AI model did not answer within the time allowed";

/**
 * A run that outlived the deadline its caller set. Distinct from a
 * cancellation (the caller or its client went away): the provider was slower
 * than the budget, so the caller says so instead of reporting an abort. The
 * deadline bounds model resolution too, so a run that never reached a model
 * ends this way as well, and the error names no provider.
 */
export class ModelDeadlineExceededError extends HandlerError {
  readonly deadlineMs: number;

  static {
    declareFailureClass(this, "model_deadline_exceeded");
  }

  constructor({ deadlineMs }: { deadlineMs: number }) {
    super({ message: MODEL_DEADLINE_EXCEEDED_MESSAGE, status: 502 });
    this.name = "ModelDeadlineExceededError";
    this.deadlineMs = deadlineMs;
  }
}
