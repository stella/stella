import readMobileUpdate from "@/api/handlers/mobile-updates/read";
import { routes } from "@/api/http/route";

// Public: a build asks for updates before anyone signs in, and the answer
// is a signed public artifact (no auth step).
export const mobileUpdatesRoute = routes(
  { "/:variant": { GET: readMobileUpdate } },
  { prefix: "/mobile/updates" },
);
