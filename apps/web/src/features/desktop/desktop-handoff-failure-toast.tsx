import type { ReactNode } from "react";

import {
  DESKTOP_HANDOFF_FAILURE,
  type DesktopHandoffFailureReason,
} from "@stll/api-contract/desktop-handoff";

import {
  detectDesktopPlatform,
  MACOS_DMG_URL,
  WINDOWS_EXE_URL,
} from "@/lib/desktop-downloads";
import { sanitizeHref } from "@/lib/sanitize-href";

type DesktopHandoffFailureMessages = {
  accountRequiredTitle: string;
  updateRequiredTitle: string;
};

export const desktopHandoffFailureToastOptions = (
  failureReason: DesktopHandoffFailureReason,
  messages: DesktopHandoffFailureMessages,
) => {
  const options = {
    [DESKTOP_HANDOFF_FAILURE.updateRequired]: {
      title: messages.updateRequiredTitle,
      description: (
        <a
          className="underline underline-offset-2"
          href={sanitizeHref(
            detectDesktopPlatform() === "mac" ? MACOS_DMG_URL : WINDOWS_EXE_URL,
          )}
        >
          {messages.updateRequiredTitle}
        </a>
      ),
      type: "error",
    },
    [DESKTOP_HANDOFF_FAILURE.accountRequired]: {
      title: messages.accountRequiredTitle,
      description: undefined,
      type: "error",
    },
  } as const satisfies Record<
    DesktopHandoffFailureReason,
    {
      title: string;
      description: ReactNode;
      type: "error";
    }
  >;
  return options[failureReason];
};
