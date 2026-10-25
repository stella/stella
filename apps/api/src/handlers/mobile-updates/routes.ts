import Elysia from "elysia";

import readMobileUpdate from "@/api/handlers/mobile-updates/read";

// Public: a build asks for updates before anyone signs in, and the answer
// is a signed public artifact (no auth macro).
export const mobileUpdatesRoute = new Elysia({
  prefix: "/mobile/updates",
}).get("/:variant", readMobileUpdate.handler, {
  params: readMobileUpdate.config.params,
  response: readMobileUpdate.config.response,
});
