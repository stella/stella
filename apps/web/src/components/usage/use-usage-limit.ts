import { useCallback, useState } from "react";

import type { UsageLimitExceededReason } from "@/components/usage/usage-limit-modal";
import { APIError } from "@/lib/errors";

/**
 * Mutation error hook that opens the usage-limit modal
 * when the backend returns 402.
 *
 * The 402 response body carries `reason`, `required`, and
 * `available` as structured fields. We prefer those when present;
 * falling back to message-text inference so older deployments
 * (and any 402 emitted by an unmetered route) still surface a
 * useful modal.
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

const NEED_HAVE_PATTERN = /need\s+(\d+),\s+have\s+(\d+)/iu;

const isReason = (value: unknown): value is UsageLimitExceededReason =>
  value === "no_entitlement" ||
  value === "entitlement_inactive" ||
  value === "usage_limit_exceeded";

const extractStructured = (
  details: Record<string, unknown> | undefined,
): {
  reason?: UsageLimitExceededReason;
  required?: number;
  available?: number;
} => {
  if (!details) {
    return {};
  }
  const out: {
    reason?: UsageLimitExceededReason;
    required?: number;
    available?: number;
  } = {};
  const rawReason = details["reason"];
  const rawRequired = details["required"];
  const rawAvailable = details["available"];
  if (isReason(rawReason)) {
    out.reason = rawReason;
  }
  if (typeof rawRequired === "number") {
    out.required = rawRequired;
  }
  if (typeof rawAvailable === "number") {
    out.available = rawAvailable;
  }
  return out;
};

/**
 * Recognise an HTTP-402 error across the two error shapes we
 * receive on the frontend:
 *
 *  - `APIError` from Eden treaty mutations (toAPIError converts
 *    a 4xx response into one of these).
 *  - The AI SDK's `AI_APICallError` from `useChat({ chat })` —
 *    streaming chat path; the SDK rejects the stream with an
 *    error whose `statusCode === 402`. Detected here by reading
 *    a numeric `statusCode` on any thrown object. Trying to
 *    import the SDK's error class would couple this hook to the
 *    chat surface; the structural check is enough.
 *
 * For both shapes we additionally require that the parsed
 * response body carries one of OUR `UsageLimitExceededReason`
 * markers — an upstream provider (OpenAI, Anthropic, etc.) that
 * surfaces a generic 402 through the AI SDK would otherwise pop
 * the usage-limit modal misleadingly, and a backend route can
 * also map provider failures into a 402 without usage details.
 *
 * Returns null when the error is not a 402 from our system.
 */
export const extractFromError = (
  error: unknown,
): { message: string; details?: Record<string, unknown> } | null => {
  if (APIError.is(error)) {
    if (error.status !== 402) {
      return null;
    }
    if (!error.details || !isReason(error.details["reason"])) {
      return null;
    }
    return {
      message: error.message,
      details: error.details,
    };
  }
  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      statusCode?: unknown;
      message?: unknown;
      responseBody?: unknown;
    };
    if (candidate.statusCode !== 402) {
      return null;
    }
    const message =
      typeof candidate.message === "string" ? candidate.message : "";
    const details = parseResponseBody(candidate.responseBody);
    if (!details || !isReason(details["reason"])) {
      // 402 without our reason marker = not from our usage-limit
      // gate; could be an upstream provider's 402 leaking
      // through the AI SDK error envelope. Decline the modal so
      // the user sees a generic toast instead of a misleading
      // usage-limit CTA for an error we did not raise.
      return null;
    }
    return { message, details };
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
    const parsed = JSON.parse(value) as unknown;
    if (isPlainObject(parsed)) {
      return parsed;
    }
  } catch {
    // Body wasn't JSON — fall through.
  }
  return undefined;
};

export const reasonFromMessage = (
  message: string,
): UsageLimitExceededReason => {
  const lower = message.toLowerCase();
  if (lower.includes("no active usage entitlement")) {
    return "no_entitlement";
  }
  if (
    lower.includes("usage entitlement") &&
    (lower.includes("cannot consume") || lower.includes("inactive"))
  ) {
    return "entitlement_inactive";
  }
  return "usage_limit_exceeded";
};

export const parseAmounts = (
  message: string,
): { required: number; available: number } => {
  const match = NEED_HAVE_PATTERN.exec(message);
  if (!match) {
    return { required: 0, available: 0 };
  }
  return {
    required: Number.parseInt(match[1] ?? "0", 10),
    available: Number.parseInt(match[2] ?? "0", 10),
  };
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

  const handle = useCallback((error: unknown): boolean => {
    const extracted = extractFromError(error);
    if (!extracted) {
      return false;
    }
    const structured = extractStructured(extracted.details);
    const reason = structured.reason ?? reasonFromMessage(extracted.message);
    const fallback = parseAmounts(extracted.message);
    setState({
      open: true,
      reason,
      required: structured.required ?? fallback.required,
      available: structured.available ?? fallback.available,
    });
    return true;
  }, []);

  const onOpenChange = useCallback(
    (open: boolean) => setState((prev) => ({ ...prev, open })),
    [],
  );

  return {
    handle,
    hasHostedEntitlement,
    modalProps: { ...state, onOpenChange },
  };
};
