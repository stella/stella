import Elysia from "elysia";

import { workspaceAccessMacro } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { subscribe } from "@/api/lib/sse";

/**
 * SSE endpoint for real-time workspace events.
 *
 * Native EventSource cannot send custom headers, so the
 * browser uses cookie credentials (`withCredentials: true`)
 * and the route reuses the normal workspace auth macro.
 */
export const workspaceEventsRoute = new Elysia({
  prefix: "/workspaces/:workspaceId",
})
  .use(workspaceAccessMacro)
  .guard({ validateWorkspaceAccess: true })
  .get(
    "/events",
    ({
      request,
      session,
      workspaceId,
    }: {
      request: Request;
      session: { activeOrganizationId: SafeId<"organization"> };
      workspaceId: SafeId<"workspace">;
    }) => {
      if (new URL(request.url).searchParams.has("token")) {
        return new Response("Token query parameter is not supported", {
          status: 400,
        });
      }

      // Create the SSE stream. Use the request's abort signal to
      // clean up when the client disconnects.
      const stream = subscribe(
        workspaceId,
        session.activeOrganizationId,
        request.signal,
      );

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-store",
          Connection: "keep-alive",
        },
      });
    },
  );
