import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

import { env } from "@/env";

import { withCrossOriginIsolationHeaders } from "../cross-origin-isolation";

// @stll/anonymize-wasm's native pipeline (2.0+) runs on a
// wasm32-wasip1-threads binding (shared memory), which browsers only
// instantiate in a cross-origin-isolated context (SharedArrayBuffer
// available). Mirror the dev server's cross-origin isolation headers
// (apps/web/vite.config.ts) here so the requirement also holds in
// production. "credentialless" (rather than "require-corp") avoids
// needing a Cross-Origin-Resource-Policy header on every cross-origin
// asset/image/font the app already loads.
export default createServerEntry({
  async fetch(request) {
    const response = await handler.fetch(request);
    return withCrossOriginIsolationHeaders(
      new URL(request.url),
      response,
      new URL(env.VITE_OUTLOOK_ORIGIN).origin,
    );
  },
});
