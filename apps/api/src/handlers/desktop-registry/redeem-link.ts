import { Result } from "better-result";

import { DESKTOP_HANDOFF_FAILURE } from "@stll/api-contract/desktop-handoff";
import {
  DESKTOP_ACCOUNT_POLICY,
  DESKTOP_ACCOUNT_PROTOCOL_HEADER,
} from "@stll/api-contract/desktop-registry";
import { Temporal } from "@stll/time";

import { CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL } from "@/api/http/cache";
import type {
  SafeHandlerGenerator,
  VerifyCaller,
} from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { issueDesktopAccountCredential } from "@/api/lib/business-registries/desktop/issuance";
import type { DesktopCredentialIdentity } from "@/api/lib/business-registries/desktop/issuance";
import {
  authorizeDesktopLinkGrant,
  desktopLinkCredentialsSchema,
} from "@/api/lib/business-registries/desktop/link-grants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

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

const issueCredential = async (
  identity: DesktopCredentialIdentity,
  request: Request,
) =>
  await issueDesktopAccountCredential({
    identity,
    recordAuditEvent: createAuditRecorder({
      userId: identity.userId,
      organizationId: identity.organizationId,
      workspaceId: null,
      request,
      server: null,
    }),
  });

const redemptionServices = {
  authorizeGrant: authorizeDesktopLinkGrant,
  authorizeLinkedAccount: authorizeDesktopAccount,
  issueCredential,
};

type LinkedDesktopCaller = {
  identity: DesktopCredentialIdentity;
  /** The request already carried the linked desktop account it redeems for. */
  linked: boolean;
};

/**
 * The caller proves itself with the one-time grant, and with the desktop
 * account it already holds when it sends one. Redeeming consumes the grant,
 * so it happens here, before anything reads the body's shape.
 */
const verifyLinkCaller =
  (services: typeof redemptionServices): VerifyCaller<LinkedDesktopCaller> =>
  async ({ body, request }) => {
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
    const linkedAccount = request.headers.has("authorization")
      ? await services.authorizeLinkedAccount(request)
      : Result.ok(null);
    if (Result.isError(linkedAccount)) {
      return Result.err(linkedAccount.error);
    }
    const linked = linkedAccount.value;
    const identity = await services.authorizeGrant(
      body,
      request,
      linked?.consumedProof,
    );
    if (Result.isError(identity)) {
      return Result.err(identity.error);
    }
    if (
      linked !== null &&
      (linked.userId !== identity.value.userId ||
        linked.organizationId !== identity.value.organizationId)
    ) {
      return Result.err(
        new HandlerError({
          status: 401,
          message: "Desktop account is unavailable",
        }),
      );
    }
    return Result.ok({ identity: identity.value, linked: linked !== null });
  };

export const createDesktopLinkRedeemHandler = (
  services: typeof redemptionServices = redemptionServices,
) =>
  createSafeTokenHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "provider_secret" },
      body: desktopLinkCredentialsSchema,
    },
    verifyLinkCaller(services),
    async function* ({
      caller: { identity, linked },
      request,
      set,
    }): SafeHandlerGenerator<DesktopLinkResponse> {
      set.headers[CACHE_CONTROL_HEADER] = PRIVATE_CACHE_CONTROL;
      if (linked) {
        return Result.ok({
          status: "connected" as const,
          identity: {
            userId: identity.userId,
            organizationId: identity.organizationId,
          },
        });
      }
      const issued = yield* Result.await(
        services.issueCredential(identity, request),
      );
      return Result.ok({
        status: "credential" as const,
        account: {
          email: issued.account.email,
          name: issued.account.name,
          verifiedAt: Temporal.Now.instant().toString(),
        },
        organizationName: issued.organizationName,
        key: issued.key,
        expiresAt: issued.expiresAt.toISOString(),
      });
    },
  );

export default createDesktopLinkRedeemHandler();
