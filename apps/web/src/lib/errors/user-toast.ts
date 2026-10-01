import { stellaToast } from "@stll/ui/toast";

import { actionAdmissionOutcome } from "@/lib/errors/action-admission";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

export const notifyUserError = (error: unknown, fallback: string): boolean => {
  // The response observer owns the refusal toast, including its contact link.
  if (actionAdmissionOutcome(error)) {
    return false;
  }
  stellaToast.add({
    title: userErrorFromThrown(error, fallback),
    type: "error",
  });
  return true;
};
