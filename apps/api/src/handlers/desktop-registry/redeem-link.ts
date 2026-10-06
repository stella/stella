import { panic, Result } from "better-result";

import { DESKTOP_HANDOFF_FAILURE } from "@stll/api-contract/desktop-handoff";
import {
  DESKTOP_ACCOUNT_POLICY,
  DESKTOP_ACCOUNT_PROTOCOL_HEADER,
} from "@stll/api-contract/desktop-registry";
import { Temporal } from "@stll/time";

import type { ScopedDb } from "@/api/db/safe-db";
import { safeDbFromScoped } from "@/api/db/safe-db";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { getAuth } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import {
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_KEY_SECONDS,
} from "@/api/lib/business-registries/desktop/config";
import { authorizeDesktopLinkGrant } from "@/api/lib/business-registries/desktop/link-grants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { permissiveBodySchema } from "@/api/lib/permissive-route-schema";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";

type DesktopLinkIdentity = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  deviceJkt: string;
};

const loadAccount = async (identity: DesktopLinkIdentity) => {
  const safeDb = safeDbFromScoped(identity.scopedDb);
  return await safeDb(async (tx) => {
    const account = await tx.query.user.findFirst({
      where: { id: { eq: identity.userId } },
      columns: { email: true, name: true },
    });
    const organization = await tx.query.organization.findFirst({
      where: { id: { eq: identity.organizationId } },
      columns: { name: true },
    });
    return account && organization
      ? { ...account, organizationName: organization.name }
      : undefined;
  });
};

const mintCredential = async (identity: DesktopLinkIdentity) =>
  await Result.tryPromise({
    try: async () => {
      const expiresAt = new Date(
        Temporal.Now.instant().epochMilliseconds +
          DESKTOP_REGISTRY_KEY_SECONDS * 1000,
      );
      const minted = await getAuth().api.createApiKey({
        body: {
          configId: DESKTOP_REGISTRY_KEY_CONFIG,
          name: "Desktop account",
          userId: identity.userId,
          expiresIn: null,
          metadata: {
            purpose: DESKTOP_REGISTRY_KEY_CONFIG,
            organizationId: identity.organizationId,
            deviceJkt: identity.deviceJkt,
            inactivityExpiresAt: expiresAt.toISOString(),
          },
        },
      });
      if (minted.expiresAt !== null) {
        panic("Desktop credentials must not enter provider expiry cleanup");
      }
      return { id: minted.id, key: minted.key, expiresAt };
    },
    catch: () =>
      new HandlerError({
        status: 503,
        message: "Could not connect desktop account",
      }),
  });

const revokeCredential = async (identity: DesktopLinkIdentity, keyId: string) =>
  await Result.tryPromise({
    try: async () => {
      await getAuth().api.updateApiKey({
        body: {
          configId: DESKTOP_REGISTRY_KEY_CONFIG,
          keyId,
          userId: identity.userId,
          enabled: false,
        },
      });
    },
    catch: () =>
      new HandlerError({
        status: 503,
        message: "Desktop connection cleanup failed",
      }),
  });

type AuditCredentialOptions = {
  identity: DesktopLinkIdentity;
  request: Request;
  keyId: string;
};
const auditCredential = async ({
  identity,
  request,
  keyId,
}: AuditCredentialOptions) => {
  const record = createAuditRecorder({
    userId: identity.userId,
    organizationId: identity.organizationId,
    workspaceId: null,
    request,
    server: null,
  });
  return await safeDbFromScoped(identity.scopedDb)(
    async (tx) =>
      await record(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.MACHINE_API_KEY,
        resourceId: keyId,
        metadata: { purpose: DESKTOP_REGISTRY_KEY_CONFIG },
      }),
  );
};

type DesktopLinkResponse =
  | {
      status: "connected";
      identity: {
        userId: SafeId<"user">;
        organizationId: SafeId<"organization">;
      };
    }
  | {
      status: "credential";
      account: { email: string; name: string; verifiedAt: string };
      organizationName: string;
      key: string;
      expiresAt: string;
    };

const redemptionServices = {
  authorizeGrant: authorizeDesktopLinkGrant,
  authorizeLinkedAccount: authorizeDesktopAccount,
  loadAccount,
  mintCredential,
  auditCredential,
  revokeCredential,
};

export const createDesktopLinkRedeemHandler = (
  services: typeof redemptionServices = redemptionServices,
) =>
  createSafeTokenHandler(
    {
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "provider_secret" },
      body: permissiveBodySchema({
        keys: [
          "correlationId",
          "verifier",
          "deviceJkt",
          "expectedUserId",
          "expectedOrganizationId",
        ],
      }),
    },
    async function* ({
      body,
      request,
      set,
    }): SafeHandlerGenerator<DesktopLinkResponse> {
      set.headers[CACHE_CONTROL_HEADER] = PRIVATE_CACHE_CONTROL;
      if (
        request.headers.get(DESKTOP_ACCOUNT_PROTOCOL_HEADER) !==
        String(DESKTOP_ACCOUNT_POLICY.linkProtocol)
      ) {
        return Result.err(
          new HandlerError({
            status: 426,
            code: DESKTOP_HANDOFF_FAILURE.updateRequired,
            message: "Update stella desktop",
            retryable: false,
          }),
        );
      }
      const linked = request.headers.has("authorization")
        ? yield* Result.await(services.authorizeLinkedAccount(request))
        : null;
      const identity = yield* Result.await(
        services.authorizeGrant(body, request, linked?.consumedProof),
      );
      if (linked) {
        if (
          linked.userId !== identity.userId ||
          linked.organizationId !== identity.organizationId
        ) {
          return Result.err(
            new HandlerError({
              status: 401,
              message: "Desktop account is unavailable",
            }),
          );
        }
        return Result.ok({
          status: "connected" as const,
          identity: {
            userId: identity.userId,
            organizationId: identity.organizationId,
          },
        });
      }
      const account = yield* Result.await(services.loadAccount(identity));
      if (!account) {
        return Result.err(
          new HandlerError({
            status: 401,
            message: "Desktop account is unavailable",
          }),
        );
      }
      const minted = yield* Result.await(services.mintCredential(identity));
      const audited = await services.auditCredential({
        identity,
        request,
        keyId: minted.id,
      });
      if (audited.isErr()) {
        yield* Result.await(services.revokeCredential(identity, minted.id));
        return Result.err(audited.error);
      }
      if (!minted.expiresAt) {
        panic("Desktop credential was minted without an expiry");
      }
      return Result.ok({
        status: "credential" as const,
        account: {
          email: account.email,
          name: account.name,
          verifiedAt: Temporal.Now.instant().toString(),
        },
        organizationName: account.organizationName,
        key: minted.key,
        expiresAt: minted.expiresAt.toISOString(),
      });
    },
  );

export default createDesktopLinkRedeemHandler();
