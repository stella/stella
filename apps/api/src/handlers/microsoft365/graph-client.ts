import { Result } from "better-result";
/**
 * Minimal delegated Microsoft Graph client for the Microsoft 365 connection.
 *
 * Two responsibilities only, deliberately narrow for this first slice:
 *   1. `ensureMicrosoft365AccessToken` — return a usable access token,
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
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import type { Microsoft365Capability } from "@stll/api-contract/microsoft365";
import { fetchWithTimeout } from "@stll/fetch";
import { readCappedBytes } from "@stll/skills/streaming";
import { Temporal } from "@stll/time";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { microsoft365Connections } from "@/api/db/schema";
import type { Microsoft365ConnectionStatus } from "@/api/db/schema";
import {
  decryptMicrosoft365Secret,
  encryptMicrosoft365Secret,
} from "@/api/handlers/microsoft365/crypto";
import {
  getMicrosoft365OAuthConfig,
  refreshAccessToken,
  tokenExpiresAt,
} from "@/api/handlers/microsoft365/graph-oauth";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { Page } from "@/api/lib/pagination";
import type { AccessToken } from "@/api/lib/secret-brands";

import { grantedCapabilities } from "./capabilities";

const GRAPH_FETCH_TIMEOUT_MS = 10_000;
const GRAPH_ACCOUNT_RESPONSE_MAX_BYTES = 64 * 1024;
const GRAPH_DRIVE_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const GRAPH_API_BASE_URL = "https://graph.microsoft.com/v1.0";
// Refresh a little early so a token does not expire mid-request.
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

/** Columns `ensureMicrosoft365AccessToken` needs from a connection row. */
export type Microsoft365ConnectionTokens = {
  id: SafeId<"microsoft365Connection">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  accessTokenEncrypted: Buffer;
  accessTokenIv: Buffer;
  refreshTokenEncrypted: Buffer | null;
  refreshTokenIv: Buffer | null;
  expiresAt: Date | null;
  status: Microsoft365ConnectionStatus;
  scope: string | null;
};

const reconnectRequiredError = (): HandlerError<409> =>
  new HandlerError({
    status: 409,
    message: "Microsoft 365 connection must be reconnected",
  });

const markReconnectRequired = async ({
  connection,
  safeDb,
}: {
  connection: Microsoft365ConnectionTokens;
  safeDb: SafeDb;
}): Promise<Result<void, SafeDbError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — token-refresh bookkeeping: flags the connection as
        // needing reconnect. The user-facing lifecycle events (connect /
        // disconnect / org-disable purge) are the audited surface.
        await tx
          .update(microsoft365Connections)
          .set({ status: "reconnect_required", updatedAt: new Date() })
          .where(
            and(
              eq(microsoft365Connections.id, connection.id),
              eq(
                microsoft365Connections.accessTokenEncrypted,
                connection.accessTokenEncrypted,
              ),
              eq(
                microsoft365Connections.organizationId,
                connection.organizationId,
              ),
              eq(microsoft365Connections.userId, connection.userId),
            ),
          );
      }),
    );
    return Result.ok(undefined);
  });

const TOKEN_REFRESH_DEPENDENCIES = {
  getMicrosoft365OAuthConfig,
  refreshAccessToken,
};

export const ensureMicrosoft365AccessToken = async (
  {
    connection,
    safeDb,
    capability,
  }: {
    connection: Microsoft365ConnectionTokens;
    safeDb: SafeDb;
    capability: Microsoft365Capability;
  },
  dependencies = TOKEN_REFRESH_DEPENDENCIES,
): Promise<
  Result<AccessToken, HandlerError<403 | 409 | 500 | 502> | SafeDbError>
> =>
  await Result.gen(async function* () {
    if (!grantedCapabilities(connection.scope).includes(capability)) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Microsoft 365 capability missing",
        }),
      );
    }
    if (connection.status !== "connected") {
      return Result.err(reconnectRequiredError());
    }
    const stillValid =
      connection.expiresAt !== null &&
      connection.expiresAt.getTime() -
        Temporal.Now.instant().epochMilliseconds >
        TOKEN_EXPIRY_BUFFER_MS;

    if (stillValid) {
      const accessToken = await decryptMicrosoft365Secret({
        purpose: "microsoft365_access_token",
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

    const config = dependencies.getMicrosoft365OAuthConfig();
    if (Result.isError(config)) {
      return Result.err(config.error);
    }

    const refreshToken = await decryptMicrosoft365Secret({
      purpose: "microsoft365_refresh_token",
      ciphertext: connection.refreshTokenEncrypted,
      iv: connection.refreshTokenIv,
      organizationId: connection.organizationId,
      userId: connection.userId,
    });

    const refreshed = await dependencies.refreshAccessToken({
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
    const encryptedAccess = await encryptMicrosoft365Secret({
      purpose: "microsoft365_access_token",
      secret: token.access_token,
      organizationId: connection.organizationId,
      userId: connection.userId,
    });
    const encryptedRefresh = token.refresh_token
      ? await encryptMicrosoft365Secret({
          purpose: "microsoft365_refresh_token",
          secret: token.refresh_token,
          organizationId: connection.organizationId,
          userId: connection.userId,
        })
      : null;

    const updated = yield* Result.await(
      safeDb(async (tx) => {
        // Compare the token snapshot so a refresh cannot overwrite a newer
        // consent grant or return a token after the connection was removed.
        // audit: skip - Token refresh bookkeeping; connection lifecycle actions own the audit trail.
        const rows = await tx
          .update(microsoft365Connections)
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
            scope: token.scope ?? connection.scope,
            expiresAt: tokenExpiresAt(token),
            status: "connected",
            lastUsedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(microsoft365Connections.id, connection.id),
              eq(
                microsoft365Connections.accessTokenEncrypted,
                connection.accessTokenEncrypted,
              ),
              eq(
                microsoft365Connections.organizationId,
                connection.organizationId,
              ),
              eq(microsoft365Connections.userId, connection.userId),
            ),
          )
          .returning({ id: microsoft365Connections.id });
        return rows.length > 0;
      }),
    );
    if (!updated) {
      return Result.err(reconnectRequiredError());
    }

    if (
      !grantedCapabilities(token.scope ?? connection.scope).includes(capability)
    ) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Microsoft 365 capability missing",
        }),
      );
    }
    // Re-decrypt what we just stored so the returned value is minted through
    // the single brand boundary, rather than casting the raw string here.
    const accessToken = await decryptMicrosoft365Secret({
      purpose: "microsoft365_access_token",
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

export type Microsoft365DriveItem = {
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
): Microsoft365DriveItem => ({
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
): Page<Microsoft365DriveItem> => ({
  items: response.value.map(toDriveItem),
  nextCursor: parseSkipToken(response["@odata.nextLink"]),
  limit,
});

const meResponseSchema = v.looseObject({
  userPrincipalName: v.optional(v.string()),
  displayName: v.optional(v.string()),
  mail: v.optional(v.string()),
});

/** Read a display label without treating a provider failure as an empty account. */
export const fetchAccountLabel = async (
  accessToken: string,
): Promise<Result<string | null, HandlerError<502>>> =>
  await Result.tryPromise({
    try: async () => {
      const url = new URL(`${GRAPH_API_BASE_URL}/me`);
      url.searchParams.set("$select", "userPrincipalName,displayName,mail");
      const response = await fetchWithTimeout(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        timeout: { type: "idle", ms: GRAPH_FETCH_TIMEOUT_MS },
        signal: AbortSignal.timeout(GRAPH_FETCH_TIMEOUT_MS),
        redirect: "error",
      });
      if (!response.ok || !response.body) {
        throw new HandlerError({
          status: 502,
          message: "Microsoft account lookup failed",
        });
      }
      const bytes = await readCappedBytes(
        response.body,
        GRAPH_ACCOUNT_RESPONSE_MAX_BYTES,
      );
      if (!bytes) {
        throw new HandlerError({
          status: 502,
          message: "Microsoft account response exceeds byte limit",
        });
      }
      const parsed = v.parse(
        meResponseSchema,
        JSON.parse(new TextDecoder().decode(bytes)),
      );
      return (
        parsed.userPrincipalName ?? parsed.mail ?? parsed.displayName ?? null
      );
    },
    catch: (cause) =>
      new HandlerError({
        status: 502,
        message: "Microsoft account lookup failed",
        cause,
      }),
  });

export const listDriveRootChildren = async ({
  accessToken,
  cursor,
  limit,
}: {
  accessToken: AccessToken;
  cursor: string | null;
  limit: number;
}): Promise<Result<Page<Microsoft365DriveItem>, HandlerError<502>>> =>
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
        timeout: { type: "idle", ms: GRAPH_FETCH_TIMEOUT_MS },
        signal: AbortSignal.timeout(GRAPH_FETCH_TIMEOUT_MS),
        redirect: "error",
      });

      if (!response.ok) {
        throw new HandlerError({
          status: 502,
          message: `Microsoft Graph returned HTTP ${response.status}`,
        });
      }

      if (!response.body) {
        throw new HandlerError({
          status: 502,
          message: "Missing Microsoft drive response",
        });
      }
      const bytes = await readCappedBytes(
        response.body,
        GRAPH_DRIVE_RESPONSE_MAX_BYTES,
      );
      if (!bytes) {
        throw new HandlerError({
          status: 502,
          message: "Microsoft drive response exceeds byte limit",
        });
      }
      const parsed = v.parse(
        driveChildrenResponseSchema,
        JSON.parse(new TextDecoder().decode(bytes)),
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
