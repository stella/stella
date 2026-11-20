import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { SHAREPOINT_REFUSAL_CODE } from "@stll/api-contract/sharepoint";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { sharepointConnections } from "@/api/db/schema";
import { assertSharepointConnectionEnabled } from "@/api/handlers/sharepoint/enablement";
import type { SharepointGraphError } from "@/api/handlers/sharepoint/graph-client";
import type { AuditRecorder } from "@/api/lib/audit-log";
import {
  acquireSharepointAccessToken,
  markReconnectRequired,
} from "@/api/lib/auth/microsoft365/graph-token";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import type { AccessToken } from "@/api/lib/secret-brands";

type WithSharepointGraphOptions<T, E> = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  safeDb: SafeDb;
  recordAuditEvent: AuditRecorder;
  signal?: AbortSignal | undefined;
  /** `E` covers the caller's own failures beside Graph's, such as storage. */
  call: (
    accessToken: AccessToken,
  ) => Promise<Result<T, SharepointGraphError | E>>;
};

/**
 * Runs one delegated Graph file read as the signed-in person: checks both
 * enablement gates, loads that person's own connection in the active
 * organization, acquires a token that carries the file capability
 * (refreshing it when needed), and runs `call`. When Graph
 * no longer accepts the token (a revoked grant), the connection is marked for
 * reconnect so the status endpoint reports it.
 */
export const withSharepointGraph = async <T, E = never>({
  organizationId,
  userId,
  safeDb,
  recordAuditEvent,
  signal,
  call,
}: WithSharepointGraphOptions<T, E>): Promise<
  Result<
    T,
    | SharepointGraphError
    | E
    | HandlerError<403 | 404 | 409 | 500 | 502>
    | SafeDbError
  >
> =>
  await Result.gen(async function* () {
    yield* Result.await(
      assertSharepointConnectionEnabled({ organizationId, safeDb }),
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
              eq(sharepointConnections.organizationId, organizationId),
              eq(sharepointConnections.userId, userId),
            ),
          )
          .limit(1),
      ),
    );

    const row = rows.at(0);
    if (!row) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: SHAREPOINT_REFUSAL_CODE.notConnected,
          message: "No SharePoint connection for this user",
          hint: "Connect a Microsoft account in stella's SharePoint settings first.",
        }),
      );
    }
    // `user_id` is stored as plain text; brand it at this boundary so the
    // token crypto's user-scoping guard receives a typed owner id.
    const connection = { ...row, userId: brandPersistedUserId(row.userId) };

    const { accessToken, accessTokenEncrypted } = yield* Result.await(
      acquireSharepointAccessToken({
        connection,
        safeDb,
        capability: "files.read",
        permit: grantThirdPartyOutboundPermit(),
        recordAuditEvent,
        signal,
      }),
    );

    const result = await call(accessToken);
    if (
      Result.isError(result) &&
      HandlerError.is(result.error) &&
      result.error.code === SHAREPOINT_REFUSAL_CODE.reconnectRequired
    ) {
      yield* Result.await(
        markReconnectRequired({
          connection: { ...connection, accessTokenEncrypted },
          safeDb,
          recordAuditEvent,
        }),
      );
    }
    return result;
  });
