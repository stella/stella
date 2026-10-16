import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { microsoft365Connections } from "@/api/db/schema";
import { assertMicrosoft365ConnectionEnabled } from "@/api/handlers/microsoft365/enablement";
import {
  ensureMicrosoft365AccessToken,
  listDriveRootChildren,
} from "@/api/handlers/microsoft365/graph-client";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const DEFAULT_PAGE_SIZE = 50;

const requestQuery = t.Object({
  cursor: t.Optional(tPaginationCursor({ maxChars: 4096 })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
});

const config = {
  contract: "patch",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "provider_secret" },
  access: "read",
  query: requestQuery,
} satisfies HandlerConfig;

// Read-only listing of the current user's default drive root, cursor-paginated
// via Graph's `@odata.nextLink` and mapped to the standard `Page<T>`. Proves
// the delegated connection works end to end; the browser UI and the import
// pipeline are separate, later slices.
const listMicrosoft365DriveRoot = createSafeRootHandler(
  config,
  async function* ({ query: input, safeDb, session, user }) {
    yield* Result.await(
      assertMicrosoft365ConnectionEnabled({
        organizationId: session.activeOrganizationId,
        safeDb,
        capabilities: ["files.read"],
      }),
    );

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: microsoft365Connections.id,
            scope: microsoft365Connections.scope,
            organizationId: microsoft365Connections.organizationId,
            userId: microsoft365Connections.userId,
            accessTokenEncrypted: microsoft365Connections.accessTokenEncrypted,
            accessTokenIv: microsoft365Connections.accessTokenIv,
            refreshTokenEncrypted:
              microsoft365Connections.refreshTokenEncrypted,
            refreshTokenIv: microsoft365Connections.refreshTokenIv,
            expiresAt: microsoft365Connections.expiresAt,
            status: microsoft365Connections.status,
          })
          .from(microsoft365Connections)
          .where(
            and(
              eq(
                microsoft365Connections.organizationId,
                session.activeOrganizationId,
              ),
              eq(microsoft365Connections.userId, user.id),
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
          message: "No Microsoft 365 connection for this user",
        }),
      );
    }

    const accessToken = yield* Result.await(
      ensureMicrosoft365AccessToken({
        capability: "files.read",
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
        limit: normalizeTenantPageLimit(input.limit ?? DEFAULT_PAGE_SIZE),
      }),
    );

    return Result.ok(page);
  },
);

export default listMicrosoft365DriveRoot;
