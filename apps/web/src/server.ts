import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

import { SSR_CACHE_CLASS_HEADER } from "@/route-response-policy";
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
    const status = requestedStatus ?? response.status;
    const cacheClass = headers.get(SSR_CACHE_CLASS_HEADER);
    headers.delete(SSR_CACHE_CLASS_HEADER);
    const isSuccessful = status >= 200 && status < 300;
    const isHtml =
      headers.get("Content-Type")?.split(";").at(0)?.trim().toLowerCase() ===
      "text/html";
    if (
      cacheClass !== "public-anonymous" ||
      !isSuccessful ||
      isHtml ||
      !headers.has("Cache-Control")
    ) {
      headers.set("Cache-Control", "private, no-store");
    }
    if (cacheClass !== "public-indexable" || !isSuccessful || !isHtml) {
      headers.set("X-Robots-Tag", "noindex");
    }

    return new Response(response.body, {
      headers,
      status,
      ...(requestedStatus === null && { statusText: response.statusText }),
    });
  },
});
