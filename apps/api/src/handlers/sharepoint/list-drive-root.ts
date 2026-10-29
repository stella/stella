import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { sharepointConnections } from "@/api/db/schema";
import { assertSharepointConnectionEnabled } from "@/api/handlers/sharepoint/enablement";
import { listDriveRootChildren } from "@/api/handlers/sharepoint/graph-client";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { ensureSharepointAccessToken } from "@/api/lib/auth/microsoft365/graph-token";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { paginationCursorSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const DEFAULT_PAGE_SIZE = 50;

const requestQuery = v.object({
  cursor: v.optional(paginationCursorSchema({ maxChars: 4096 })),
  limit: v.optional(
    numberFromString(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
    ),
  ),
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
const listSharepointDriveRoot = createSafeRootHandler(
  config,
  async function* ({
    query: input,
    request,
    safeDb,
    session,
    user,
    recordAuditEvent,
  }) {
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
            scope: sharepointConnections.scope,
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

    const permit = grantThirdPartyOutboundPermit();
    const accessToken = yield* Result.await(
      ensureSharepointAccessToken({
        // `user_id` is stored as plain text; brand it at this boundary so the
        // token crypto's user-scoping guard receives a typed owner id.
        connection: {
          ...connection,
          userId: brandPersistedUserId(connection.userId),
        },
        safeDb,
        capability: "files.read",
        permit,
        recordAuditEvent,
        signal: request.signal,
      }),
    );

    const page = yield* Result.await(
      listDriveRootChildren({
        accessToken,
        permit,
        cursor: input.cursor ?? null,
        limit: normalizeTenantPageLimit(input.limit ?? DEFAULT_PAGE_SIZE),
        signal: request.signal,
      }),
    );

    return Result.ok(page);
  },
);

export default listSharepointDriveRoot;
