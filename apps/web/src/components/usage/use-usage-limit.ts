import { useState } from "react";

import type { UsageLimitExceededReason } from "@/components/usage/usage-limit-modal";
import { APIError } from "@/lib/errors/api";

/**
 * Mutation error hook that opens the usage-limit modal
 * when the backend returns 402.
 *
 * The 402 response body carries `reason`, `required`, and
 * `available` as structured fields; the API writes the three together.
 *
 * Usage:
 *
 *   const usageLimit = useUsageLimit();
 *   const m = useMutation({
 *     mutationFn: doAiThing,
 *     onError: (error) => {
 *       if (usageLimit.handle(error)) return; // modal opens
 *       genericToast(error);
 *     },
 *   });
 *   return <>
 *     <button onClick={() => m.mutate()}>Do it</button>
 *     <UsageLimitModal {...usageLimit.modalProps} />
 *   </>;
 */

type ModalState = {
  open: boolean;
  required: number;
  available: number;
  reason: UsageLimitExceededReason;
};

const INITIAL_STATE: ModalState = {
  open: false,
  required: 0,
  available: 0,
  reason: "usage_limit_exceeded",
};

const isReason = (value: unknown): value is UsageLimitExceededReason =>
  value === "no_entitlement" ||
  value === "entitlement_inactive" ||
  value === "usage_limit_exceeded";

const unitsOf = (value: unknown): number =>
  typeof value === "number" ? value : 0;

type UsageLimitRefusal = {
  reason: UsageLimitExceededReason;
  details: Record<string, unknown>;
};

/**
 * Recognise an HTTP-402 error across the error shapes we
 * receive on the frontend:
 *
 *  - `APIError` from API client mutations (toAPIError converts
 *    a 4xx response into one of these).
 *  - Streaming/provider transport errors whose `statusCode === 402`.
 *    Detected here by reading a numeric `statusCode` on any thrown
 *    object so this hook stays decoupled from the chat runtime.
 *
 * For both shapes we additionally require that the parsed
 * response body carries one of OUR `UsageLimitExceededReason`
 * markers — an upstream provider (OpenAI, Anthropic, etc.) that
 * surfaces a generic 402 through the transport layer would otherwise pop
 * the usage-limit modal misleadingly, and a backend route can
 * also map provider failures into a 402 without usage details.
 *
 * Returns null when the error is not a 402 from our system.
 */
export const extractFromError = (error: unknown): UsageLimitRefusal | null => {
  if (APIError.is(error)) {
    if (error.status !== 402) {
      return null;
    }
    const { details } = error;
    const reason = details?.["reason"];
    if (!details || !isReason(reason)) {
      return null;
    }
    return { reason, details };
  }
  if (typeof error === "object" && error !== null) {
    const statusCode = "statusCode" in error ? error.statusCode : undefined;
    if (statusCode !== 402) {
      return null;
    }
    const responseBody =
      "responseBody" in error ? error.responseBody : undefined;
    const details = parseResponseBody(responseBody);
    const reason = details?.["reason"];
    if (!details || !isReason(reason)) {
      // 402 without our reason marker = not from our usage-limit
      // gate; could be an upstream provider's 402 leaking
      // through the transport error envelope. Decline the modal so
      // the user sees a generic toast instead of a misleading
      // usage-limit CTA for an error we did not raise.
      return null;
    }
    return { reason, details };
  }
  return null;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseResponseBody = (
  value: unknown,
): Record<string, unknown> | undefined => {
  if (isPlainObject(value)) {
    return value;
  }
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (isPlainObject(parsed)) {
      return parsed;
    }
  } catch {
    // Body wasn't JSON — fall through.
  }
  return undefined;
};

export type UseUsageLimitResult = {
  /**
   * Pass any thrown mutation error here. Returns true if the
   * modal opened (caller should NOT show a generic toast in that
   * case).
   */
  handle: (error: unknown) => boolean;
  modalProps: ModalState & {
    onOpenChange: (open: boolean) => void;
  };
};

export const useUsageLimit = ({
  hasHostedEntitlement,
}: {
  hasHostedEntitlement: boolean;
}): UseUsageLimitResult & { hasHostedEntitlement: boolean } => {
  const [state, setState] = useState<ModalState>(INITIAL_STATE);

  const handle = (error: unknown): boolean => {
    const extracted = extractFromError(error);
    if (!extracted) {
      return false;
    }
    setState({
      open: true,
      reason: extracted.reason,
      required: unitsOf(extracted.details["required"]),
      available: unitsOf(extracted.details["available"]),
    });
    return true;
  };

  const onOpenChange = (open: boolean) =>
    setState((prev) => ({ ...prev, open }));

  return {
    handle,
    hasHostedEntitlement,
    modalProps: { ...state, onOpenChange },
  };
};
