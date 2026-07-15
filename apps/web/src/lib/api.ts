import { treaty } from "@elysiajs/eden";
import { posthog } from "posthog-js";

import type { API } from "@stll/api/types";

import { env } from "@/env";
import { getFormattingLocale, getMessageLocale } from "@/i18n/i18n-store";
import { getSimulateSlowLoadDelayMs } from "@/lib/dev-store";

const FORMATTING_LOCALE_HEADER = "x-stella-formatting-locale";

const eden = treaty<API>(env.VITE_API_URL, {
  parseDate: false,
  fetch: {
    credentials: "include",
  },
  async onRequest() {
    const delayMs = getSimulateSlowLoadDelayMs();
    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  },
  headers() {
    if (typeof window === "undefined") {
      return {};
    }

    // Message language and regional formatting are independent preferences.
    // Keep Accept-Language tied to translated copy; the dedicated formatting
    // header carries the full BCP-47 tag for exports and server-side Intl.
    const result: Record<string, string> = {
      "Accept-Language": getMessageLocale(),
      [FORMATTING_LOCALE_HEADER]: getFormattingLocale(),
    };

    const sessionId = posthog.get_session_id();
    if (sessionId) {
      result["x-posthog-session-id"] = sessionId;
    }

    return result;
  },
});

export const api = eden.v1;
