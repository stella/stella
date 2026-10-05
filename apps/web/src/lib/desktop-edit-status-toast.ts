import type { ReactNode } from "react";

import { stellaToast } from "@stll/ui/toast";

import { DesktopHandoffFailedError } from "@/features/desktop/desktop-edit-handoff";
import { desktopHandoffFailureToastOptions } from "@/features/desktop/desktop-handoff-failure-toast";
import { getAnalytics } from "@/lib/analytics/provider";
import type { OpenFileInDesktopResult } from "@/lib/desktop-bridge";
import { DesktopBridgeIncompatibleError } from "@/lib/desktop-bridge";
import { notifyUserError } from "@/lib/errors/user-toast";

type DesktopEditToastMessages = {
  accountRequiredTitle: string;
  notOpenedDescription: ReactNode;
  openedDescription: ReactNode;
  openedTitle: string;
  sentDescription: ReactNode;
  sentTitle: string;
  unavailableTitle: string;
  updateRequiredDescription: string;
  updateRequiredTitle: string;
};

export const showDesktopEditOpenResultToast = async ({
  messages,
  result,
}: {
  messages: DesktopEditToastMessages;
  result: OpenFileInDesktopResult;
}) => {
  if (result.type === "opened") {
    stellaToast.add({
      description: messages.openedDescription,
      title: messages.openedTitle,
      type: "success",
    });
    return;
  }

  const toastId = stellaToast.add({
    description: messages.sentDescription,
    title: messages.sentTitle,
    type: "loading",
  });

  try {
    await result.waitUntilOpened;
    stellaToast.update(toastId, {
      description: messages.openedDescription,
      title: messages.openedTitle,
      type: "success",
    });
  } catch (error) {
    if (DesktopHandoffFailedError.is(error)) {
      const options = desktopHandoffFailureToastOptions(
        error.failureReason,
        messages,
      );
      notifyUserError(error, options.title, {
        toastId,
        description: options.description,
      });
      return;
    }
    getAnalytics().captureError(error);
    if (error instanceof DesktopBridgeIncompatibleError) {
      notifyUserError(error, messages.updateRequiredTitle, {
        toastId,
        description: messages.updateRequiredDescription,
      });
      return;
    }

    notifyUserError(error, messages.unavailableTitle, {
      toastId,
      description: messages.notOpenedDescription,
    });
  }
};
