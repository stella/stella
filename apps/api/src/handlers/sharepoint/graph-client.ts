/**
 * Minimal delegated Microsoft Graph client for the SharePoint connection.
 *
 * Two responsibilities only, deliberately narrow for this first slice:
 *   1. `ensureSharepointAccessToken` — return a usable access token,
 *      refreshing it when expired and persisting the rotated tokens. On any
 *      refresh failure the connection is marked `reconnect_required` and the
 *      failure is surfaced (never swallowed), so a stale token can never be
 *      used silently.
 *   2. `listDriveRootChildren` — read the current user's default drive root,
 *      mapped from Graph's `@odata.nextLink` pagination into the standard
 *      `Page<T>` envelope.
 *
 * There is no import pipeline, no write path, and no background sync here.
 */

import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { sharepointConnections } from "@/api/db/schema";
import type { SharepointConnectionStatus } from "@/api/db/schema";
import {
  decryptSharepointSecret,
  encryptSharepointSecret,
} from "@/api/handlers/sharepoint/crypto";
import {
  GRAPH_API_BASE_URL,
  getSharepointOAuthConfig,
  refreshAccessToken,
  tokenExpiresAt,
} from "@/api/handlers/sharepoint/graph-oauth";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { fetchWithTimeout } from "@/api/lib/fetch";
import type { Page } from "@/api/lib/pagination";
import type { AccessToken } from "@/api/lib/secret-brands";

const GRAPH_FETCH_TIMEOUT_MS = 10_000;
// Refresh a little early so a token does not expire mid-request.
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

/** Columns `ensureSharepointAccessToken` needs from a connection row. */
export type SharepointConnectionTokens = {
  id: SafeId<"sharepointConnection">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  accessTokenEncrypted: Buffer;
  accessTokenIv: Buffer;
  refreshTokenEncrypted: Buffer | null;
  refreshTokenIv: Buffer | null;
  expiresAt: Date | null;
  status: SharepointConnectionStatus;
};

const reconnectRequiredError = (): HandlerError<409> =>
  new HandlerError({
    status: 409,
    message: "SharePoint connection must be reconnected",
  });

const markReconnectRequired = async ({
  connection,
  safeDb,
}: {
  connection: SharepointConnectionTokens;
  safeDb: SafeDb;
}): Promise<Result<void, SafeDbError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — token-refresh bookkeeping: flags the connection as
        // needing reconnect. The user-facing lifecycle events (connect /
        // disconnect / org-disable purge) are the audited surface.
        await tx
          .update(sharepointConnections)
          .set({ status: "reconnect_required", updatedAt: new Date() })
          .where(
            and(
              eq(sharepointConnections.id, connection.id),
              eq(
                sharepointConnections.organizationId,
                connection.organizationId,
              ),
              eq(sharepointConnections.userId, connection.userId),
            ),
          );
      }),
    );
    return Result.ok(undefined);
  });

export const ensureSharepointAccessToken = async ({
  connection,
  safeDb,
}: {
  connection: SharepointConnectionTokens;
  safeDb: SafeDb;
}): Promise<Result<AccessToken, HandlerError<409 | 500 | 502> | SafeDbError>> =>
  await Result.gen(async function* () {
    const stillValid =
      connection.status === "connected" &&
      connection.expiresAt !== null &&
      connection.expiresAt.getTime() - Date.now() > TOKEN_EXPIRY_BUFFER_MS;

    if (stillValid) {
      const accessToken = await decryptSharepointSecret({
        purpose: "sharepoint_access_token",
        ciphertext: connection.accessTokenEncrypted,
        iv: connection.accessTokenIv,
        organizationId: connection.organizationId,
        userId: connection.userId,
      });
      return Result.ok(accessToken);
    }

    if (!connection.refreshTokenEncrypted || !connection.refreshTokenIv) {
      yield* Result.await(markReconnectRequired({ connection, safeDb }));
      return Result.err(reconnectRequiredError());
    }

    const config = getSharepointOAuthConfig();
    if (Result.isError(config)) {
      return Result.err(config.error);
    }

    const refreshToken = await decryptSharepointSecret({
      purpose: "sharepoint_refresh_token",
      ciphertext: connection.refreshTokenEncrypted,
      iv: connection.refreshTokenIv,
      organizationId: connection.organizationId,
      userId: connection.userId,
    });

    const refreshed = await refreshAccessToken({
      clientId: config.value.clientId,
      clientSecret: config.value.clientSecret,
      refreshToken,
      tenantId: config.value.tenantId,
    });

    if (Result.isError(refreshed)) {
      yield* Result.await(markReconnectRequired({ connection, safeDb }));
      return Result.err(reconnectRequiredError());
    }

    const token = refreshed.value;
    const encryptedAccess = await encryptSharepointSecret({
      purpose: "sharepoint_access_token",
      secret: token.access_token,
      organizationId: connection.organizationId,
      userId: connection.userId,
    });
    const encryptedRefresh = token.refresh_token
      ? await encryptSharepointSecret({
          purpose: "sharepoint_refresh_token",
          secret: token.refresh_token,
          organizationId: connection.organizationId,
          userId: connection.userId,
        })
      : null;

    yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — token-refresh bookkeeping: rotates the stored access /
        // refresh tokens after a silent Graph refresh. The user-facing
        // lifecycle events (connect / disconnect / org-disable purge) are the
        // audited surface.
        await tx
          .update(sharepointConnections)
          .set({
            accessTokenEncrypted: encryptedAccess.ciphertext,
            accessTokenIv: encryptedAccess.iv,
            ...(encryptedRefresh
              ? {
                  refreshTokenEncrypted: encryptedRefresh.ciphertext,
                  refreshTokenIv: encryptedRefresh.iv,
                }
              : {}),
            tokenType: token.token_type ?? "Bearer",
            scope: token.scope ?? null,
            expiresAt: tokenExpiresAt(token),
            status: "connected",
            lastUsedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(sharepointConnections.id, connection.id),
              eq(
                sharepointConnections.organizationId,
                connection.organizationId,
              ),
              eq(sharepointConnections.userId, connection.userId),
            ),
          );
      }),
    );

    // Re-decrypt what we just stored so the returned value is minted through
    // the single brand boundary, rather than casting the raw string here.
    const accessToken = await decryptSharepointSecret({
      purpose: "sharepoint_access_token",
      ciphertext: encryptedAccess.ciphertext,
      iv: encryptedAccess.iv,
      organizationId: connection.organizationId,
      userId: connection.userId,
    });
    return Result.ok(accessToken);
  });

const driveItemSchema = v.looseObject({
  id: v.string(),
  name: v.optional(v.string()),
  webUrl: v.optional(v.string()),
  eTag: v.optional(v.string()),
  size: v.optional(v.number()),
  lastModifiedDateTime: v.optional(v.string()),
  folder: v.optional(v.looseObject({ childCount: v.optional(v.number()) })),
  file: v.optional(v.looseObject({ mimeType: v.optional(v.string()) })),
});

const driveChildrenResponseSchema = v.looseObject({
  value: v.array(driveItemSchema),
  "@odata.nextLink": v.optional(v.string()),
});

export type DriveChildrenResponse = v.InferOutput<
  typeof driveChildrenResponseSchema
>;

export type SharepointDriveItem = {
  id: string;
  name: string;
  kind: "file" | "folder";
  mimeType: string | null;
  webUrl: string | null;
  eTag: string | null;
  size: number | null;
  lastModifiedDateTime: string | null;
};

const toDriveItem = (
  item: v.InferOutput<typeof driveItemSchema>,
): SharepointDriveItem => ({
  id: item.id,
  name: item.name ?? "Untitled",
  kind: item.folder ? "folder" : "file",
  mimeType: item.file?.mimeType ?? null,
  webUrl: item.webUrl ?? null,
  eTag: item.eTag ?? null,
  size: item.size ?? null,
  lastModifiedDateTime: item.lastModifiedDateTime ?? null,
});

// Graph returns an opaque `$skiptoken` inside `@odata.nextLink`. Extract just
// the token and re-issue the request ourselves; we never fetch a
// client-supplied URL (that would be an SSRF vector).
const parseSkipToken = (nextLink: string | undefined): string | null => {
  if (!nextLink) {
    return null;
  }
  try {
    return new URL(nextLink).searchParams.get("$skiptoken");
  } catch {
    return null;
  }
};

/** Pure mapping from a Graph children response to our `Page<T>` envelope. */
export const mapDriveChildrenToPage = (
  response: DriveChildrenResponse,
  limit: number,
): Page<SharepointDriveItem> => ({
  items: response.value.map(toDriveItem),
  nextCursor: parseSkipToken(response["@odata.nextLink"]),
  limit,
});

const meResponseSchema = v.looseObject({
  userPrincipalName: v.optional(v.string()),
  displayName: v.optional(v.string()),
  mail: v.optional(v.string()),
});

/**
 * Best-effort display label for the connected Microsoft account, read once at
 * connect time. Boundary try/catch: a failure here must never block the
 * connection, so it degrades to `null`. `accessToken` is the raw token fresh
 * from the code exchange (not yet a stored `Secret`).
 */
export const fetchAccountLabel = async (
  accessToken: string,
): Promise<string | null> => {
  try {
    const url = new URL(`${GRAPH_API_BASE_URL}/me`);
    url.searchParams.set("$select", "userPrincipalName,displayName,mail");
    const response = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      timeoutMs: GRAPH_FETCH_TIMEOUT_MS,
    });
    if (!response.ok) {
      return null;
    }
    const parsed = v.parse(meResponseSchema, await response.json());
    return (
      parsed.userPrincipalName ?? parsed.mail ?? parsed.displayName ?? null
    );
  } catch {
    return null;
  }
};

export const listDriveRootChildren = async ({
  accessToken,
  cursor,
  limit,
}: {
  accessToken: AccessToken;
  cursor: string | null;
  limit: number;
}): Promise<Result<Page<SharepointDriveItem>, HandlerError<502>>> =>
  await Result.tryPromise({
    try: async () => {
      const url = new URL(`${GRAPH_API_BASE_URL}/me/drive/root/children`);
      url.searchParams.set("$top", String(limit));
      if (cursor) {
        url.searchParams.set("$skiptoken", cursor);
      }

      const response = await fetchWithTimeout(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        timeoutMs: GRAPH_FETCH_TIMEOUT_MS,
      });

      if (!response.ok) {
        throw new HandlerError({
          status: 502,
          message: `Microsoft Graph returned HTTP ${response.status}`,
        });
      }

      const parsed = v.parse(
        driveChildrenResponseSchema,
        await response.json(),
      );
      return mapDriveChildrenToPage(parsed, limit);
    },
    // Always surface a 502 so the Result error channel unifies to
    // HandlerError<502>; preserve the message from our own thrown 502.
    catch: (cause): HandlerError<502> =>
      new HandlerError({
        status: 502,
        message: HandlerError.is(cause)
          ? cause.message
          : "Failed to reach Microsoft Graph",
        cause,
      }),
  });
