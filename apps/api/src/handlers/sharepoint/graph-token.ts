import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { Microsoft365Capability } from "@stll/api-contract/microsoft365";
import { Temporal } from "@stll/time";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { sharepointConnections } from "@/api/db/schema";
import type { SharepointConnectionStatus } from "@/api/db/schema";
import {
  capabilityEnabled,
  consentedScopes,
  delegatedScopes,
  grantedCapabilities,
  scopeSet,
} from "@/api/handlers/sharepoint/capabilities";
import {
  decryptSharepointSecret,
  encryptSharepointSecret,
} from "@/api/handlers/sharepoint/crypto";
import {
  getSharepointOAuthConfig,
  refreshAccessToken,
  tokenExpiresAt,
} from "@/api/handlers/sharepoint/graph-oauth";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transition } from "@/api/lib/db/transitions";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { AccessToken } from "@/api/lib/secret-brands";
import {
  lockSharepointPolicy,
  readLockedSharepointPolicy,
} from "@/api/lib/sharepoint-policy-lock";

// Refresh before Graph can observe expiry mid-request.
const TOKEN_EXPIRY_BUFFER_MS = 60_000;
const TOKEN_COLLABORATORS = {
  getSharepointOAuthConfig,
  refreshAccessToken,
};

/** Columns `ensureSharepointAccessToken` needs from a connection row. */
type SharepointConnectionTokens = {
  id: SafeId<"sharepointConnection">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  accessTokenEncrypted: Buffer;
  accessTokenIv: Buffer;
  refreshTokenEncrypted: Buffer | null;
  refreshTokenIv: Buffer | null;
  expiresAt: Date | null;
  status: SharepointConnectionStatus;
  scope: string | null;
};

const reconnectRequiredError = (): HandlerError<409> =>
  new HandlerError({
    status: 409,
    message: "SharePoint connection must be reconnected",
  });

const markReconnectRequired = async ({
  connection,
  safeDb,
  recordAuditEvent,
}: {
  connection: SharepointConnectionTokens;
  safeDb: SafeDb;
  recordAuditEvent: AuditRecorder;
}) =>
  await safeDb(
    async (tx) =>
      await transition({
        tx,
        spec: TRANSITIONS.sharepointConnections,
        id: connection.id,
        options: {
          from: ["connected"],
          to: "reconnect_required",
          fence: connection.accessTokenEncrypted,
          set: { updatedAt: new Date() },
        },
        recordTransitionAuditEvent: async (auditTx) => {
          await recordAuditEvent(auditTx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
            resourceId: connection.organizationId,
            workspaceId: null,
            metadata: {
              operation: "sharepoint_reconnect_required",
              connectionUserId: connection.userId,
            },
          });
        },
      }),
  );

type TokenOptions = {
  connection: SharepointConnectionTokens;
  safeDb: SafeDb;
  capability: Microsoft365Capability;
  permit: ThirdPartyOutboundPermit;
  recordAuditEvent: AuditRecorder;
  signal?: AbortSignal | undefined;
};

const refreshSharepointAccessToken = async (
  {
    connection,
    safeDb,
    capability,
    permit,
    recordAuditEvent,
    requestedScope,
    signal,
  }: TokenOptions & { requestedScope: string },
  collaborators = TOKEN_COLLABORATORS,
): Promise<
  Result<AccessToken, HandlerError<403 | 409 | 500 | 502> | SafeDbError>
> =>
  await Result.gen(async function* () {
    if (!connection.refreshTokenEncrypted || !connection.refreshTokenIv) {
      yield* Result.await(
        markReconnectRequired({ connection, safeDb, recordAuditEvent }),
      );
      return Result.err(reconnectRequiredError());
    }

    const config = collaborators.getSharepointOAuthConfig();
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

    const refreshed = await collaborators.refreshAccessToken({
      clientId: config.value.clientId,
      clientSecret: config.value.clientSecret,
      permit,
      refreshToken,
      scope: requestedScope,
      signal,
      tenantId: config.value.tenantId,
    });

    if (Result.isError(refreshed)) {
      if (signal?.aborted) {
        return Result.err(refreshed.error);
      }
      yield* Result.await(
        markReconnectRequired({ connection, safeDb, recordAuditEvent }),
      );
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

    const stored = yield* Result.await(
      safeDb(async (tx) => {
        // A refresh cannot overwrite a newer grant or return a token after
        // the connection was removed during the external Graph round trip.
        // Serialize with a selective policy change before storing any scope.
        const currentPolicy = await lockSharepointPolicy({
          tx,
          organizationId: connection.organizationId,
          recordAuditEvent,
        });
        const scope = consentedScopes({
          providerScope: token.scope,
          requestedScope,
          policy: currentPolicy,
        });
        const rows = await tx
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
            scope,
            expiresAt: tokenExpiresAt(token),
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
              eq(sharepointConnections.status, "connected"),
              eq(
                sharepointConnections.accessTokenEncrypted,
                connection.accessTokenEncrypted,
              ),
            ),
          )
          .returning({ id: sharepointConnections.id });
        if (
          rows.length > 0 &&
          JSON.stringify(scopeSet(connection.scope)) !==
            JSON.stringify(scopeSet(scope))
        ) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
            resourceId: connection.organizationId,
            workspaceId: null,
            metadata: {
              operation: "sharepoint_refresh_scope_change",
              connectionUserId: connection.userId,
              oldScopes: scopeSet(connection.scope),
              newScopes: scopeSet(scope),
              grantedCapabilities: grantedCapabilities(scope),
            },
          });
        }
        return {
          updated: rows.length > 0,
          capabilityGranted: grantedCapabilities(scope).includes(capability),
        };
      }),
    );
    if (!stored.updated) {
      return Result.err(reconnectRequiredError());
    }
    if (!stored.capabilityGranted) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Microsoft capability missing",
        }),
      );
    }

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

export const ensureSharepointAccessToken = async (
  {
    connection,
    safeDb,
    capability,
    permit,
    recordAuditEvent,
    signal,
  }: TokenOptions,
  collaborators = TOKEN_COLLABORATORS,
): Promise<
  Result<AccessToken, HandlerError<403 | 409 | 500 | 502> | SafeDbError>
> =>
  await Result.gen(async function* () {
    if (connection.status !== "connected") {
      return Result.err(reconnectRequiredError());
    }
    if (connection.scope === null) {
      // Older rows lack evidence of the provider's grant. Keep their tokens
      // encrypted at rest, but require explicit consent before another read.
      yield* Result.await(
        markReconnectRequired({ connection, safeDb, recordAuditEvent }),
      );
      return Result.err(reconnectRequiredError());
    }
    if (!grantedCapabilities(connection.scope).includes(capability)) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Microsoft capability missing",
        }),
      );
    }
    const policy = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: connection.organizationId } },
          columns: {
            sharepointConnectionEnabled: true,
            microsoft365CalendarReadEnabled: true,
          },
        }),
      ),
    );
    if (!capabilityEnabled(policy, capability)) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Microsoft capability is not enabled",
        }),
      );
    }
    const requestedScope = delegatedScopes({
      requested: [],
      grantedScope: connection.scope,
      policy,
    });
    const stillValid =
      connection.expiresAt !== null &&
      connection.expiresAt.getTime() -
        Temporal.Now.instant().epochMilliseconds >
        TOKEN_EXPIRY_BUFFER_MS;

    if (stillValid) {
      // A consent replacement can race the caller's connection read. Check
      // the current grant and ciphertext under the same settings-then-token
      // lock order as connect, refresh, and organization revocation.
      const admission = yield* Result.await(
        safeDb(async (tx) => {
          const currentPolicy = await readLockedSharepointPolicy({
            tx,
            organizationId: connection.organizationId,
            mode: "share",
          });
          if (!capabilityEnabled(currentPolicy, capability)) {
            return "denied" as const;
          }
          const lock = await withAggregateLock({
            aggregate: "sharepointConnection",
            id: {
              id: connection.id,
              organizationId: connection.organizationId,
            },
            mode: "share",
            tx,
          });
          if (lock.status === "missing") {
            return "stale" as const;
          }
          if (lock.status !== "locked") {
            return panic("Blocking SharePoint token acquisition returned busy");
          }
          const current = (
            await tx
              .select({
                accessTokenEncrypted:
                  sharepointConnections.accessTokenEncrypted,
                accessTokenIv: sharepointConnections.accessTokenIv,
                expiresAt: sharepointConnections.expiresAt,
                scope: sharepointConnections.scope,
                status: sharepointConnections.status,
              })
              .from(sharepointConnections)
              .where(
                and(
                  eq(sharepointConnections.id, connection.id),
                  eq(
                    sharepointConnections.organizationId,
                    connection.organizationId,
                  ),
                  eq(sharepointConnections.userId, connection.userId),
                ),
              )
              .limit(1)
          ).at(0);
          return current?.status === "connected" &&
            current.scope === connection.scope &&
            current.expiresAt?.getTime() === connection.expiresAt?.getTime() &&
            current.accessTokenEncrypted.equals(
              connection.accessTokenEncrypted,
            ) &&
            current.accessTokenIv.equals(connection.accessTokenIv)
            ? ("current" as const)
            : ("stale" as const);
        }),
      );
      if (admission === "denied") {
        return Result.err(
          new HandlerError({
            status: 403,
            message: "Microsoft capability is not enabled",
          }),
        );
      }
      if (admission === "stale") {
        return Result.err(reconnectRequiredError());
      }
      const accessToken = await decryptSharepointSecret({
        purpose: "sharepoint_access_token",
        ciphertext: connection.accessTokenEncrypted,
        iv: connection.accessTokenIv,
        organizationId: connection.organizationId,
        userId: connection.userId,
      });
      return Result.ok(accessToken);
    }

    const refreshed = yield* Result.await(
      refreshSharepointAccessToken(
        {
          connection,
          safeDb,
          capability,
          permit,
          recordAuditEvent,
          requestedScope,
          signal,
        },
        collaborators,
      ),
    );
    return Result.ok(refreshed);
  });
