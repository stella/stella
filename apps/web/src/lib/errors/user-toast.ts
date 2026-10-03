import { stellaToast } from "@stll/ui/toast";

import { notifyActionAdmissionRefusal } from "@/components/action-admission-outcome";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

type UserErrorToastOptions = Omit<
  Parameters<typeof stellaToast.add>[0],
  "title" | "type"
> & { toastId?: string };

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
