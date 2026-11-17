import {
  CHAT_TRANSPORT_ERROR_CODE,
  type ChatTransportErrorCode,
  type ChatTransportErrorPayload,
  isChatTransportErrorCode,
} from "@stll/anonymize-chat";

import type { ChatTurnFailureCode } from "@/api/handlers/chat/chat-turn-state";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { emitAnonymizationRefusalMetric } from "@/api/lib/observability/request-metrics";
import type {
  AnonymizationRefusalReason,
  AnonymizationRefusalSite,
} from "@/api/lib/observability/request-metrics";

type AnonymizationRefusalStatus = 422 | 500;
const BOUNDARY_REFUSAL_FAILURE_CODE =
  "boundary-refusal" satisfies ChatTurnFailureCode;

export type AnonymizationRefusal<
  TStatus extends AnonymizationRefusalStatus = AnonymizationRefusalStatus,
> = HandlerError<TStatus> & {
  readonly failureCode: typeof BOUNDARY_REFUSAL_FAILURE_CODE;
};

/**
 * The error a refused crossing of the anonymized boundary returns, counted as
 * it is built. Every such refusal in the API is built here (the guard in
 * `anonymization-refusal.test.ts` holds that), so a refusal cannot reach a
 * user, or a model as a failed tool call, without being measured.
 *
 * `offerRawRetry` sets the transport code that lets the client offer to send
 * without anonymization; leave it off where sending raw cannot help.
 * `rawRetryCode` names why, for a client to say so; content stella cannot
 * anonymize unless told otherwise.
 */
export const refuseAnonymizedCrossing = <
  TStatus extends AnonymizationRefusalStatus,
>({
  cause,
  message,
  offerRawRetry,
  rawRetryCode = CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
  reason,
  site,
  status,
}: {
  cause?: unknown;
  message: string;
  offerRawRetry: boolean;
  rawRetryCode?: ChatTransportErrorCode;
  reason: AnonymizationRefusalReason;
  site: AnonymizationRefusalSite;
  status: TStatus;
}): AnonymizationRefusal<TStatus> => {
  emitAnonymizationRefusalMetric({ reason, site });
  return Object.assign(
    new HandlerError({
      ...(offerRawRetry ? { code: rawRetryCode } : {}),
      ...(cause === undefined ? {} : { cause }),
      message,
      status,
    }),
    { failureCode: BOUNDARY_REFUSAL_FAILURE_CODE } as const,
  );
};

/**
 * What a chat turn refused at the boundary answers with: the refusal's own
 * code, so the client can say why, and its message.
 */
export const anonymizationRefusalPayload = (
  error: AnonymizationRefusal,
): ChatTransportErrorPayload => ({
  code: isChatTransportErrorCode(error.code)
    ? error.code
    : CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
  message: error.message,
});
