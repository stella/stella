import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

import { SSR_STATUS_HEADER, ssrStatusFromHeader } from "@/ssr-response-status";

// @stll/anonymize-wasm's native pipeline (2.0+) runs on a
// wasm32-wasip1-threads binding (shared memory), which browsers only
// instantiate in a cross-origin-isolated context (SharedArrayBuffer
// available). Mirror the dev server's cross-origin isolation headers
// (apps/web/vite.config.ts) here so the requirement also holds in
// production. "credentialless" (rather than "require-corp") avoids
// needing a Cross-Origin-Resource-Policy header on every cross-origin
// asset/image/font the app already loads.
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
} as const;

export default createServerEntry({
  async fetch(request) {
    const response = await handler.fetch(request);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(
      CROSS_ORIGIN_ISOLATION_HEADERS,
    )) {
      headers.set(name, value);
    }
    // A route that rendered a degraded page names the status it wants; the
    // marker is consumed here so only the status crosses the wire.
    const requestedStatus = ssrStatusFromHeader(headers.get(SSR_STATUS_HEADER));
    headers.delete(SSR_STATUS_HEADER);

    return new Response(response.body, {
      headers,
      status: requestedStatus ?? response.status,
      ...(requestedStatus === null && { statusText: response.statusText }),
    });
  },
});
