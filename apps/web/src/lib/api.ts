import { treaty } from "@elysiajs/eden";
import { posthog } from "posthog-js";

import type { API } from "@stll/api/types";

import { env } from "@/env";
import { getFormattingLocale } from "@/i18n/i18n-store";
import { getSimulateSlowLoadDelayMs } from "@/lib/dev-store";

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

    // Carry the app's current UI/formatting locale so server-side i18n
    // (default view names, Intl formatting) follows the in-app language
    // rather than the browser's Accept-Language. The full tag preserves
    // Unicode (-u-) calendar/numbering extensions.
    const result: Record<string, string> = {
      "Accept-Language": getFormattingLocale(),
    };

    const sessionId = posthog.get_session_id();
    if (sessionId) {
      result["x-posthog-session-id"] = sessionId;
    }

    return result;
  },
});

export const api = eden.v1;
