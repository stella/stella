import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { sharepointConnections } from "@/api/db/schema";
import { assertSharepointConnectionEnabled } from "@/api/handlers/sharepoint/enablement";
import {
  ensureSharepointAccessToken,
  listDriveRootChildren,
} from "@/api/handlers/sharepoint/graph-client";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const DEFAULT_PAGE_SIZE = 50;

const requestQuery = t.Object({
  cursor: t.Optional(tPaginationCursor({ maxChars: 4096 })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
});

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "provider_secret" },
  query: requestQuery,
} satisfies HandlerConfig;

// Read-only listing of the current user's default drive root, cursor-paginated
// via Graph's `@odata.nextLink` and mapped to the standard `Page<T>`. Proves
// the delegated connection works end to end; the browser UI and the import
// pipeline are separate, later slices.
const listSharepointDriveRoot = createSafeRootHandler(
  config,
  async function* ({ query: input, safeDb, session, user }) {
    yield* Result.await(
      assertSharepointConnectionEnabled({
        organizationId: session.activeOrganizationId,
        safeDb,
      }),
    );

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: sharepointConnections.id,
            organizationId: sharepointConnections.organizationId,
            userId: sharepointConnections.userId,
            accessTokenEncrypted: sharepointConnections.accessTokenEncrypted,
            accessTokenIv: sharepointConnections.accessTokenIv,
            refreshTokenEncrypted: sharepointConnections.refreshTokenEncrypted,
            refreshTokenIv: sharepointConnections.refreshTokenIv,
            expiresAt: sharepointConnections.expiresAt,
            status: sharepointConnections.status,
          })
          .from(sharepointConnections)
          .where(
            and(
              eq(
                sharepointConnections.organizationId,
                session.activeOrganizationId,
              ),
              eq(sharepointConnections.userId, user.id),
            ),
          )
          .limit(1),
      ),
    );

    const connection = rows.at(0);
    if (!connection) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "No SharePoint connection for this user",
        }),
      );
    }

    const accessToken = yield* Result.await(
      ensureSharepointAccessToken({
        // `user_id` is stored as plain text; brand it at this boundary so the
        // token crypto's user-scoping guard receives a typed owner id.
        connection: {
          ...connection,
          userId: brandPersistedUserId(connection.userId),
        },
        safeDb,
      }),
    );

    const page = yield* Result.await(
      listDriveRootChildren({
        accessToken,
        cursor: input.cursor ?? null,
        limit: input.limit ?? DEFAULT_PAGE_SIZE,
      }),
    );

    return Result.ok(page);
  },
);

export default listSharepointDriveRoot;
