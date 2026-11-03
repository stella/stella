import { desktopRunnerUnavailable } from "@/api/lib/desktop-runner/gateway";
import { upgradeDesktopRunner } from "@/api/lib/desktop-runner/runtime";
import { defineEndpoint } from "@/api/lib/endpoints";

/**
 * Opens a desktop's runner socket. Plumbing rather than a capability: the
 * gateway authenticates the upgrade itself (desktop account token plus a
 * single-use device proof) and refuses before upgrading. Once Bun has taken
 * the request over it ignores whatever the route returns.
 */
export default defineEndpoint.public({}, async ({ request, server }) => {
  if (server === null) {
    return desktopRunnerUnavailable({
      reason: "The request has no server socket to upgrade",
      body: "Desktop runners need a server socket",
    });
  }
  return (
    (await upgradeDesktopRunner(request, server)) ??
    new Response(null, { status: 200 })
  );
});
