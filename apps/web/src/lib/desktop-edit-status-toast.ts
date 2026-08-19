import type { ReactNode } from "react";

import { stellaToast } from "@stll/ui/toast";

import { getAnalytics } from "@/lib/analytics/provider";
import type { OpenFileInDesktopResult } from "@/lib/desktop-bridge";
import { DesktopBridgeIncompatibleError } from "@/lib/desktop-bridge";

type DesktopEditToastMessages = {
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
    getAnalytics().captureError(error);
    if (error instanceof DesktopBridgeIncompatibleError) {
      stellaToast.update(toastId, {
        description: messages.updateRequiredDescription,
        title: messages.updateRequiredTitle,
        type: "error",
      });
      return;
    }

    stellaToast.update(toastId, {
      description: messages.notOpenedDescription,
      title: messages.unavailableTitle,
      type: "error",
    });
  }
};
