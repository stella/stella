import Elysia, { t } from "elysia";

import { validateBearerAuth } from "@/api/lib/auth";
import { tUuid } from "@/api/lib/custom-schema";
import { subscribe } from "@/api/lib/sse";

/**
 * SSE endpoint for real-time workspace events.
 *
 * Auth uses a query-param bearer token because the native
 * EventSource API cannot send custom headers. This route is
 * a separate Elysia instance (no shared auth guard) so it
 * can validate the token from the query string directly.
 */
export const workspaceEventsRoute = new Elysia({
  prefix: "/workspaces/:workspaceId",
}).get(
  "/events",
  async ({ params, query, request }) => {
    const auth = await validateBearerAuth(query.token);

    if (!auth) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Verify the user can access this workspace.
    const ws = auth.accessibleWorkspaces.find(
      (w) => w.id === params.workspaceId && w.status === "active",
    );

    if (!ws) {
      return new Response("Not Found", { status: 404 });
    }

    // Create the SSE stream. Use the request's abort signal to
    // clean up when the client disconnects.
    const stream = subscribe(ws.id, auth.organizationId, request.signal);

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
      },
    });
  },
  {
    params: t.Object({ workspaceId: tUuid }),
    query: t.Object({ token: t.String({ minLength: 1 }) }),
  },
);
