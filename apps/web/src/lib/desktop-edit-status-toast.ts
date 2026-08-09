import { stellaToast } from "@stll/ui/components/toast";

import type { OpenFileInDesktopResult } from "@/lib/desktop-bridge";
import { DesktopBridgeIncompatibleError } from "@/lib/desktop-bridge";

type DesktopEditToastMessages = {
  notOpenedDescription: string;
  openedDescription: string;
  openedTitle: string;
  sentDescription: string;
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
