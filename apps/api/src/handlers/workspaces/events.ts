import { routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
import type { WorkspaceEndpointContext } from "@/api/lib/endpoints";
import { sseResponse, subscribe } from "@/api/lib/sse";

/**
 * SSE endpoint for real-time workspace events.
 *
 * Native EventSource cannot send custom headers, so the browser uses cookie
 * credentials (`withCredentials: true`) and the route uses the ordinary
 * workspace access. A `?token=` credential is refused: a query-string secret
 * lands in proxy logs, referrers and history.
 */
const workspaceEvents = defineEndpoint.workspace(
  {},
  ({ request, session, user, workspaceId }: WorkspaceEndpointContext) => {
    if (new URL(request.url).searchParams.has("token")) {
      return new Response("Token query parameter is not supported", {
        status: 400,
      });
    }
    // The request's abort signal ends the stream when the client disconnects.
    return sseResponse(
      subscribe({
        organizationId: session.activeOrganizationId,
        sessionId: session.id,
        signal: request.signal,
        userId: user.id,
        workspaceId,
      }),
      {
        kind: "session",
        sessionId: session.id,
        userId: user.id,
      },
    );
  },
);

export const workspaceEventsRoute = routes(
  { "/events": { GET: workspaceEvents } },
  { prefix: "/workspaces/:workspaceId" },
);
