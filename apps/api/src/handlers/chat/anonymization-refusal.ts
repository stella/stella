import { CHAT_TRANSPORT_ERROR_CODE } from "@stll/anonymize-chat";

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
 */
export const refuseAnonymizedCrossing = <
  TStatus extends AnonymizationRefusalStatus,
>({
  cause,
  message,
  offerRawRetry,
  reason,
  site,
  status,
}: {
  cause?: unknown;
  message: string;
  offerRawRetry: boolean;
  reason: AnonymizationRefusalReason;
  site: AnonymizationRefusalSite;
  status: TStatus;
}): AnonymizationRefusal<TStatus> => {
  emitAnonymizationRefusalMetric({ reason, site });
  return Object.assign(
    new HandlerError({
      ...(offerRawRetry
        ? { code: CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal }
        : {}),
      ...(cause === undefined ? {} : { cause }),
      message,
      status,
    }),
    { failureCode: BOUNDARY_REFUSAL_FAILURE_CODE },
  );
};
