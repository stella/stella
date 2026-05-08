import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { mcpUserConnections } from "@/api/db/schema";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const routeParams = t.Object({
  connectionId: tSafeId("mcpUserConnection"),
});

const config = {
  permissions: { workspace: ["read"] },
  params: routeParams,
} satisfies HandlerConfig;

const deleteMcpConnection = createSafeRootHandler(
  config,
  async function* ({ params: requestParams, safeDb, session, user }) {
    const deleted = yield* Result.await(
      safeDb((tx) =>
        tx
          .delete(mcpUserConnections)
          .where(
            and(
              eq(mcpUserConnections.id, requestParams.connectionId),
              eq(
                mcpUserConnections.organizationId,
                session.activeOrganizationId,
              ),
              eq(mcpUserConnections.userId, user.id),
            ),
          )
          .returning({ id: mcpUserConnections.id }),
      ),
    );

    const connection = deleted.at(0);
    if (!connection) {
      return Result.err(
        new HandlerError({ status: 404, message: "MCP connection not found" }),
      );
    }

    return Result.ok(connection);
  },
);

export default deleteMcpConnection;
