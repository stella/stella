import type { AIErrorKind } from "@stll/api-contract";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { HandlerErrorStatusCode } from "@/api/lib/errors/tagged-errors";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";

export const PROVIDER_CALL_ERROR_MESSAGE = "AI provider request failed";

type ProviderCallErrorOptions = {
  model: Pick<ResolvedTanStackTextModel, "provider" | "keySource">;
  status: HandlerErrorStatusCode;
  code?: string | undefined;
  kind: AIErrorKind;
  facts?: { status: number; isRetryable?: boolean } | undefined;
  requestId?: string | undefined;
};

export class ProviderCallError extends HandlerError {
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
