import type { AIErrorKind } from "@stll/api-contract";
import { declareFailureClass } from "@stll/errors";

import { MANAGED_PROVIDER_UNAVAILABLE_CODE } from "@/api/lib/chat/provider-data-policy";
import {
  INCOMPLETE_STREAM_CODE,
  TRUNCATED_AT_OUTPUT_CEILING_CODE,
} from "@/api/lib/chat/provider-stream-contract";
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
  code?: ProviderCallErrorCode | undefined;
  kind: AIErrorKind;
  facts?: { status: number; isRetryable?: boolean } | undefined;
  requestId?: string | undefined;
};

export class ProviderCallError extends HandlerError {
  declare code?: ProviderCallErrorCode | undefined;
  readonly provider: ResolvedTanStackTextModel["provider"];
  readonly keySource: ResolvedTanStackTextModel["keySource"];
  readonly providerStatus: number | undefined;
  readonly requestId: string | undefined;
  readonly kind: AIErrorKind;

  constructor({
    model,
    status,
    code,
    kind,
    facts,
    requestId,
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
    this.name = "ProviderCallError";
    this.provider = model.provider;
    this.keySource = model.keySource;
    this.providerStatus = facts?.status;
    this.requestId = requestId;
    this.kind = kind;
  }
}

type ModelRunErrorOptions = {
  model: Pick<ResolvedTanStackTextModel, "provider" | "keySource">;
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

  constructor(
    { model }: ModelRunErrorOptions,
    message: string = MODEL_RUN_ERROR_MESSAGE,
  ) {
    super({ message, status: 502 });
    this.name = "ModelRunError";
    this.provider = model.provider;
    this.keySource = model.keySource;
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

export const MODEL_OUTPUT_INVALID_MESSAGE =
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

export const MODEL_DEADLINE_EXCEEDED_MESSAGE =
  "The AI model did not answer within the time allowed";

/**
 * A run that outlived the deadline its caller set. Distinct from a
 * cancellation (the caller or its client went away): the provider was slower
 * than the budget, so the caller says so instead of reporting an abort.
 */
export class ModelDeadlineExceededError extends ModelRunError {
  readonly deadlineMs: number;

  static {
    declareFailureClass(this, "model_deadline_exceeded");
  }

  constructor({
    deadlineMs,
    model,
  }: ModelRunErrorOptions & { deadlineMs: number }) {
    super({ model }, MODEL_DEADLINE_EXCEEDED_MESSAGE);
    this.name = "ModelDeadlineExceededError";
    this.deadlineMs = deadlineMs;
  }
}
