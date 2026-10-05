import { createDetached } from "@stll/errors";
import { stellaToast } from "@stll/ui/toast";

import { notifyActionAdmissionRefusal } from "@/components/action-admission-outcome";
import { getAnalytics } from "@/lib/analytics/provider";
import { toAuthClientError } from "@/lib/errors/auth";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

type UserErrorToastOptions = Omit<
  Parameters<typeof stellaToast.add>[0],
  "title" | "type"
> & { toastId?: string | undefined };

export const notifyUserError = (
  error: unknown,
  fallback: string,
  { toastId, ...options }: UserErrorToastOptions = {},
): boolean => {
  // The stable refusal id coalesces Eden's observer and local error handlers;
  // raw fetch and SDK errors also need to emit the same notice here.
  if (notifyActionAdmissionRefusal(error)) {
    if (toastId !== undefined) {
      stellaToast.close(toastId);
    }
    return false;
  }
  const toast = {
    ...options,
    title: userErrorFromThrown(error, fallback),
    type: "error",
  } as const;
  if (toastId !== undefined) {
    stellaToast.update(toastId, toast);
    return true;
  }
  stellaToast.add(toast);
  return true;
};

const SERVER_ERROR_THRESHOLD = 500;

export const notifyAuthClientError = (
  error: Parameters<typeof toAuthClientError>[0],
  fallback: string,
) =>
  notifyUserError(toAuthClientError(error), fallback, {
    description:
      error.status < SERVER_ERROR_THRESHOLD
        ? (error.message ?? fallback)
        : fallback,
  });

type DetachedUserActionOptions = {
  /** A fixed label for telemetry, as `detached` takes. */
  context: string;
  /** What the person is told when the action fails. */
  failureMessage: string;
};

/**
 * Run work a person started with a press, without awaiting it. Unlike
 * `detached`, a rejection is shown as well as reported: a press must never
 * end in nothing.
 */
export const detachedUserAction = (
  operation: unknown,
  { context, failureMessage }: DetachedUserActionOptions,
): void => {
  createDetached((error, label) => {
    getAnalytics().captureError(error, { type: "detached", operation: label });
    notifyUserError(error, failureMessage);
  })(operation, context);
};
