import { treaty } from "@elysiajs/eden";
import { posthog } from "posthog-js";

import type { API } from "@stll/api/types";

import { env } from "@/env";
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

    const sessionId = posthog.get_session_id();
    return sessionId ? { "x-posthog-session-id": sessionId } : {};
  },
});

export const api = eden.v1;
