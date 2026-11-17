import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { RESOURCE_TYPE, resourceRef } from "@stll/api-contract";

import { desktopEditHandoffs } from "@/api/db/schema";
import { env } from "@/api/env";
import { status } from "@/api/http/status";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { authorizeDesktopHandoff } from "@/api/lib/business-registries/desktop/handoff-auth";
import type { DesktopHandoffAuthorizationDependencies } from "@/api/lib/business-registries/desktop/handoff-auth";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import {
  consumeDesktopEditHandoff,
  createDesktopEditHandoffSafeDb,
  markDesktopEditHandoffOpened,
  readDesktopEditHandoffAccess,
} from "@/api/lib/desktop-edit-handoffs";
import {
  computeDesktopEditHandoffExpiresAt,
  createDesktopEditHandoffToken,
  hashDesktopEditHandoffToken,
} from "@/api/lib/desktop-edit-sessions";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observedStatus } from "@/api/lib/observability/server-error-answer";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { requireSessionCredentialIssuer } from "@/api/lib/synthetic-principal/credential-policy";

import type { DesktopEditHandoffStatusResponse } from "./desktop-edit-handoffs.logic";
import { resolveDesktopEditHandoffStatus } from "./desktop-edit-handoffs.logic";
import { openDesktopEditSessionHandler } from "./open-desktop-edit-session";

const HANDOFF_TOKEN_PATTERN = "^[0-9a-f]{64}$";

const DESKTOP_EDIT_HANDOFF_FAILED = failureSink({
  event: "desktop_edit.handoff_failed",
  expected: [],
});

const stripTrailingSlashes = (value: string) => {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
};

const DESKTOP_EDIT_API_BASE_URL = stripTrailingSlashes(
  env.PUBLIC_URL ?? env.BETTER_AUTH_URL,
);

const linkedAccountSchema = v.nullable(
  v.object({
    email: v.pipe(v.string(), v.maxLength(320)),
    name: v.nullable(v.pipe(v.string(), v.maxLength(256))),
    verifiedAt: v.pipe(v.string(), v.maxLength(64)),
  }),
);

const createDesktopEditHandoffBodySchema = v.object({
  entityId: resourceIdSchema("entity"),
  force: v.optional(v.boolean()),
  linkedAccount: linkedAccountSchema,
  propertyId: resourceIdSchema("property"),
});

const desktopEditHandoffStatusParamsSchema = workspaceParams({
  handoffId: resourceIdSchema("desktopEditHandoff"),
});

export const redeemDesktopEditHandoffBodySchema = v.object({
  handoffToken: v.pipe(
    v.string(),
    v.minLength(64),
    v.maxLength(64),
    v.regex(new RegExp(HANDOFF_TOKEN_PATTERN, "u")),
  ),
});

export const acknowledgeDesktopEditHandoffOpenedParamsSchema = v.object({
  handoffId: resourceIdSchema("desktopEditHandoff"),
});

export const acknowledgeDesktopEditHandoffOpenedBodySchema = v.object({
  handoffToken: v.pipe(
    v.string(),
    v.minLength(64),
    v.maxLength(64),
    v.regex(new RegExp(HANDOFF_TOKEN_PATTERN, "u")),
  ),
  sessionId: resourceIdSchema("desktopEditSession"),
});

type AcknowledgeDesktopEditHandoffOpenedParams = v.InferOutput<
  typeof acknowledgeDesktopEditHandoffOpenedParamsSchema
>;
type AcknowledgeDesktopEditHandoffOpenedBody = v.InferOutput<
  typeof acknowledgeDesktopEditHandoffOpenedBodySchema
>;

type BuildDesktopEditHandoffDeepLinkProps = {
  apiBaseUrl: string;
  handoffToken: string;
};

const buildDesktopEditHandoffDeepLink = ({
  apiBaseUrl,
  handoffToken,
}: BuildDesktopEditHandoffDeepLinkProps) => {
  const url = new URL("stella://desktop-edit/open");
  url.searchParams.set("handoff", handoffToken);
  url.searchParams.set("apiBaseUrl", apiBaseUrl);
  return url.toString();
};

const createConfig = {
  contract: "patch",
  body: createDesktopEditHandoffBodySchema,
  permissions: { entity: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "session_token_exchange" },
} satisfies WorkspaceHandlerConfig;

export const createDesktopEditHandoff = createSafeHandler(
  createConfig,
  async function* ({
    body: { entityId, force, linkedAccount, propertyId },
    safeDb,
    user,
    workspaceId,
    recordAuditEvent,
  }) {
    requireSessionCredentialIssuer("desktopHandoff", { userId: user.id });
    const apiBaseUrl = DESKTOP_EDIT_API_BASE_URL;
    const handoffId = createSafeId<"desktopEditHandoff">();
    const handoffToken = createDesktopEditHandoffToken({ userId: user.id });
    const tokenHash = hashDesktopEditHandoffToken(handoffToken);
    const expiresAt = computeDesktopEditHandoffExpiresAt();

    yield* Result.await(
      safeDb(async (tx) => {
        await tx.insert(desktopEditHandoffs).values({
          apiBaseUrl,
          createdBy: user.id,
          entityId,
          expiresAt,
          forceTakeover: force === true,
          id: handoffId,
          linkedAccount,
          propertyId,
          tokenHash,
          workspaceId,
        });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
          resourceId: handoffId,
          changes: {
            created: {
              old: null,
              new: {
                entityId,
                propertyId,
                forceTakeover: force === true,
              },
            },
          },
          metadata: { kind: "handoff" },
        });
      }),
    );

    return Result.ok({
      deepLinkUrl: buildDesktopEditHandoffDeepLink({
        apiBaseUrl,
        handoffToken,
      }),
      expiresAt: expiresAt.toISOString(),
      handoffId,
    });
  },
);

const statusConfig = {
  contract: "patch",
  params: desktopEditHandoffStatusParamsSchema,
  permissions: { entity: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "session_token_exchange" },
} satisfies WorkspaceHandlerConfig;

export const readDesktopEditHandoffStatus = createSafeHandler<
  typeof statusConfig,
  DesktopEditHandoffStatusResponse
>(
  statusConfig,
  async function* ({ params: { handoffId }, safeDb, user, workspaceId }) {
    const rows = yield* Result.await(
      safeDb(
        async (tx) =>
          await tx
            .select({
              consumedAt: desktopEditHandoffs.consumedAt,
              desktopSessionId: desktopEditHandoffs.desktopSessionId,
              expiresAt: desktopEditHandoffs.expiresAt,
              failedAt: desktopEditHandoffs.failedAt,
              failureReason: desktopEditHandoffs.failureReason,
              openedAt: desktopEditHandoffs.openedAt,
            })
            .from(desktopEditHandoffs)
            .where(
              and(
                eq(desktopEditHandoffs.id, handoffId),
                eq(desktopEditHandoffs.workspaceId, workspaceId),
                eq(desktopEditHandoffs.createdBy, user.id),
              ),
            )
            .limit(1),
      ),
    );

    const handoff = rows.at(0);
    if (!handoff) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Desktop edit handoff not found.",
        }),
      );
    }

    return Result.ok(
      resolveDesktopEditHandoffStatus({
        consumedAt: handoff.consumedAt,
        desktopSessionId: handoff.desktopSessionId,
        expiresAt: handoff.expiresAt,
        failedAt: handoff.failedAt,
        failureReason: handoff.failureReason,
        now: new Date(),
        openedAt: handoff.openedAt,
      }),
    );
  },
);

export const redeemDesktopEditHandoffHandler = async (
  {
    body: { handoffToken },
    request,
    server,
  }: {
    body: { handoffToken: string };
    request: Request;
    server: Parameters<typeof createAuditRecorder>[0]["server"];
  },
  dependencies?: DesktopHandoffAuthorizationDependencies,
) => {
  const authorization = await authorizeDesktopHandoff(
    {
      request,
      handoffToken,
      kind: "desktop_edit",
    },
    dependencies,
  );
  if (authorization.isErr()) {
    return observedStatus(
      { sink: DESKTOP_EDIT_HANDOFF_FAILED, cause: authorization.error },
      authorization.error.status,
      {
        code: authorization.error.code,
        message: authorization.error.message,
        retryable: authorization.error.retryable,
      },
    );
  }
  const consumed = await consumeDesktopEditHandoff({
    handoffToken,
    identity: authorization.value,
  });
  if (consumed.isErr()) {
    return observedStatus(
      { sink: DESKTOP_EDIT_HANDOFF_FAILED, cause: consumed.error },
      consumed.error.status,
      {
        code: consumed.error.code,
        message: consumed.error.message,
      },
    );
  }
  const handoff = consumed.value;
  if (!handoff) {
    return status(410, {
      message: "Desktop edit handoff expired or has already been used.",
    });
  }

  const access = await readDesktopEditHandoffAccess({
    createdBy: handoff.createdBy,
    workspaceId: handoff.workspaceId,
  });

  if (!access) {
    return status(404, { message: "Workspace not found." });
  }

  if (!access.canWriteWorkspaceEntities) {
    return status(403, { message: "Desktop editing permission was revoked." });
  }

  const safeDb = createDesktopEditHandoffSafeDb({
    organizationId: access.organizationId,
    userId: brandPersistedUserId(handoff.createdBy),
    workspaceId: handoff.workspaceId,
  });

  const recordAuditEvent = createAuditRecorder({
    organizationId: access.organizationId,
    workspaceId: handoff.workspaceId,
    userId: brandPersistedUserId(handoff.createdBy),
    request,
    server,
  });

  const result = await Result.gen(async function* () {
    return yield* openDesktopEditSessionHandler({
      body: {
        entityId: handoff.entityId,
        ...(handoff.forceTakeover && { force: true }),
        propertyId: handoff.propertyId,
      },
      organizationId: access.organizationId,
      recordAuditEvent,
      safeDb,
      source: { kind: "background", reason: "desktop edit session fixture" },
      userId: brandPersistedUserId(handoff.createdBy),
      workspaceId: handoff.workspaceId,
    });
  });

  if (Result.isError(result)) {
    const error = result.error;
    const answer = {
      sink: DESKTOP_EDIT_HANDOFF_FAILED,
      cause: error,
      ctx: { workspaceId: handoff.workspaceId },
    };

    if (HandlerError.is(error)) {
      return observedStatus(answer, error.status, {
        ...(error.code ? { code: error.code } : {}),
        message: error.message,
      });
    }

    return observedStatus(answer, 500, { message: "Internal server error" });
  }

  broadcastWorkspaceResourceUpdated(
    handoff.workspaceId,
    resourceRef({ type: RESOURCE_TYPE.ENTITY, id: handoff.entityId }),
  );

  return {
    apiBaseUrl: handoff.apiBaseUrl,
    identity: {
      userId: authorization.value.userId,
      organizationId: authorization.value.organizationId,
    },
    entityId: handoff.entityId,
    handoffId: handoff.id,
    linkedAccount: handoff.linkedAccount,
    propertyId: handoff.propertyId,
    remoteSession: result.value,
    workspaceId: handoff.workspaceId,
  };
};

export const acknowledgeDesktopEditHandoffOpenedHandler = async ({
  body: { handoffToken, sessionId },
  params: { handoffId },
  request,
}: {
  request: Request;
  body: AcknowledgeDesktopEditHandoffOpenedBody;
  params: AcknowledgeDesktopEditHandoffOpenedParams;
}) => {
  const authorization = await authorizeDesktopAccount(request);
  if (authorization.isErr()) {
    return observedStatus(
      { sink: DESKTOP_EDIT_HANDOFF_FAILED, cause: authorization.error },
      authorization.error.status,
      { message: authorization.error.message },
    );
  }
  const acknowledged = await markDesktopEditHandoffOpened({
    identity: authorization.value,
    handoffId,
    handoffToken,
    sessionId,
  });

  if (!acknowledged) {
    return status(410, {
      message: "Desktop edit handoff acknowledgement was rejected.",
    });
  }

  return { ok: true };
};

export default createDesktopEditHandoff;
