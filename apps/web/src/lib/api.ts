import { treaty } from "@elysiajs/eden";
import { posthog } from "posthog-js";

import type { API } from "@stll/api/types";

import { env } from "@/env";

const eden = treaty<API>(env.VITE_API_URL, {
  parseDate: false,
  fetch: {
    credentials: "include",
  },
  headers() {
    const sessionId = posthog.get_session_id();
    return sessionId ? { "x-posthog-session-id": sessionId } : {};
  },
});

export const api = eden.v1;
