import { treaty } from "@elysiajs/eden";

import type { API } from "@stll/api/types";

import { env } from "@/env";
import { getAuthToken } from "@/lib/auth";

const REQUEST_TIMEOUT_MS = 10_000;

const eden = treaty<API>(env.apiBaseUrl, {
  parseDate: false,
  fetch: {
    credentials: "omit",
  },
  headers: () => {
    const token = getAuthToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  },
});

export const api = eden.v1;

export const withTimeout = () => ({
  fetch: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
});
