import { posthog } from "posthog-js";

import { getFormattingLocale, getMessageLocale } from "@/i18n/i18n-store";
import { getSimulateSlowLoadDelayMs } from "@/lib/dev-store";

const FORMATTING_LOCALE_HEADER = "x-stella-formatting-locale";

export const waitForSimulatedApiDelay = async (): Promise<void> => {
  const delayMs = getSimulateSlowLoadDelayMs();
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
};

export const getApiRequestHeaders = (): Record<string, string> => {
  if (typeof window === "undefined") {
    return {};
  }

  const result: Record<string, string> = {
    "Accept-Language": getMessageLocale(),
    [FORMATTING_LOCALE_HEADER]: getFormattingLocale(),
  };
  const sessionId = posthog.get_session_id();
  if (sessionId) {
    result["x-posthog-session-id"] = sessionId;
  }
  return result;
};
