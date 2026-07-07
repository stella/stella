import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

// @stll/anonymize-wasm's native pipeline (2.0+) runs on a
// wasm32-wasip1-threads binding (shared memory), which browsers only
// instantiate in a cross-origin-isolated context (SharedArrayBuffer
// available). Mirror the dev server's cross-origin isolation headers
// (apps/web/vite.config.ts) here so the requirement also holds in
// production. "credentialless" (rather than "require-corp") avoids
// needing a Cross-Origin-Resource-Policy header on every cross-origin
// asset/image/font the app already loads.
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
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
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  },
});
