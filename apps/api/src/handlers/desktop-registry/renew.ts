import { Result } from "better-result";
import { t } from "elysia";

import type { DesktopAccountIdentity } from "@stll/api-contract/desktop-rpc";

import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import {
  probeDesktopCredential,
  renewDesktopCredential,
} from "@/api/lib/business-registries/desktop/renewal";
import { tUserId } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type DesktopRenewalResponse = {
  expiresAt: string;
  identity: DesktopAccountIdentity;
};

const renewDesktopAccount = createSafeBoundedPublicHandler(
  {
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "auth_plumbing" },
    cache: { kind: "none" },
    body: t.Union([
      t.Object(
        {
          type: t.Literal("rotate"),
          successorKey: t.String({ minLength: 1, maxLength: 256 }),
        },
        { additionalProperties: false },
      ),
      t.Object({ type: t.Literal("probe") }, { additionalProperties: false }),
    ]),
    response: safePublicHandlerResponseSchemasWithStatusText(
      t.Object(
        {
          expiresAt: t.String({ format: "date-time", maxLength: 64 }),
          identity: t.Object(
            {
              userId: tUserId,
              organizationId: t.String({ minLength: 1, maxLength: 128 }),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  async function* ({
    request,
    body,
  }): SafeHandlerGenerator<DesktopRenewalResponse> {
    const context = yield* Result.await(authorizeDesktopAccount(request));
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return Result.err(
        new HandlerError({
          status: 401,
          message: "Reconnect desktop to your account",
        }),
      );
    }
    if (body.type === "probe") {
      const recovered = yield* Result.await(
        probeDesktopCredential({
          keyId: context.keyId,
          userId: context.userId,
          organizationId: context.organizationId,
          currentKey: authorization.slice(7),
        }),
      );
      return Result.ok({
        ...recovered,
        identity: {
          userId: context.userId,
          organizationId: context.organizationId,
        },
      });
    }
    const recordAuditEvent = createAuditRecorder({
      userId: context.userId,
      organizationId: context.organizationId,
      workspaceId: null,
      request,
      server: null,
    });
    const rotated = yield* Result.await(
      renewDesktopCredential({
        keyId: context.keyId,
        userId: context.userId,
        organizationId: context.organizationId,
        currentKey: authorization.slice(7),
        successorKey: body.successorKey,
        recordAuditEvent,
      }),
    );
    return Result.ok({
      ...rotated,
      identity: {
        userId: context.userId,
        organizationId: context.organizationId,
      },
    });
  },
);

// The renewal owner locks desktopMembership then desktopCredential through
// the aggregate lock owner inside its own transaction.
declareAggregateMutation(renewDesktopAccount.handler, {
  type: "aggregate",
  aggregates: ["desktopMembership", "desktopCredential"],
});

export default renewDesktopAccount;
