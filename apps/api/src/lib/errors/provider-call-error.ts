import type { AIErrorKind } from "@stll/api-contract";

import { MANAGED_PROVIDER_UNAVAILABLE_CODE } from "@/api/lib/chat/provider-data-policy";
import {
  INCOMPLETE_STREAM_CODE,
  TRUNCATED_AT_OUTPUT_CEILING_CODE,
} from "@/api/lib/chat/provider-stream-contract";
import type { RedactedProviderDiagnostic } from "@/api/lib/errors/provider-diagnostic";
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
  providerDiagnostic?: RedactedProviderDiagnostic | undefined;
};

const diagnostics = new WeakMap<
  ProviderCallError,
  RedactedProviderDiagnostic
>();

export class ProviderCallError extends HandlerError {
  declare code?: ProviderCallErrorCode | undefined;
  readonly provider: ResolvedTanStackTextModel["provider"];
  readonly keySource: ResolvedTanStackTextModel["keySource"];
  readonly providerStatus: number | undefined;
  readonly requestId: string | undefined;
  readonly kind: AIErrorKind;

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

  constructor({ model }: ModelRunErrorOptions) {
    super({ message: MODEL_RUN_ERROR_MESSAGE, status: 502 });
    this.name = "ModelRunError";
    this.provider = model.provider;
    this.keySource = model.keySource;
  }
}
