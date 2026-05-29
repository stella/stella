import { treaty } from "@elysiajs/eden";

import type { API } from "@stll/api/types";

const REQUEST_TIMEOUT_MS = 10_000;

const eden = treaty<API>(`${window.location.origin}/api`, {
  parseDate: false,
  fetch: {
    credentials: "include",
  },
});

export const api = eden.v1;

export const withTimeout = () => ({
  fetch: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
});
