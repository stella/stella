import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { desktopEditHandoffs } from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
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
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { broadcast } from "@/api/lib/sse";

import type { DesktopEditHandoffStatusResponse } from "./desktop-edit-handoffs.logic";
import { resolveDesktopEditHandoffStatus } from "./desktop-edit-handoffs.logic";
import { openDesktopEditSessionHandler } from "./open-desktop-edit-session";

const HANDOFF_TOKEN_PATTERN = "^[0-9a-f]{64}$";

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

const linkedAccountSchema = t.Nullable(
  t.Object({
    email: t.String({ maxLength: 320 }),
    name: t.Nullable(t.String({ maxLength: 256 })),
    verifiedAt: t.String({ maxLength: 64 }),
  }),
);

export const createDesktopEditHandoffBodySchema = t.Object({
  entityId: tSafeId("entity"),
  force: t.Optional(t.Boolean()),
  linkedAccount: linkedAccountSchema,
  propertyId: tSafeId("property"),
});

export const desktopEditHandoffStatusParamsSchema = t.Object({
  handoffId: tSafeId("desktopEditHandoff"),
});

export const redeemDesktopEditHandoffBodySchema = t.Object({
  handoffToken: t.String({
    minLength: 64,
    maxLength: 64,
    pattern: HANDOFF_TOKEN_PATTERN,
  }),
});

export const acknowledgeDesktopEditHandoffOpenedParamsSchema = t.Object({
  handoffId: tSafeId("desktopEditHandoff"),
});

export const acknowledgeDesktopEditHandoffOpenedBodySchema = t.Object({
  handoffToken: t.String({
    minLength: 64,
    maxLength: 64,
    pattern: HANDOFF_TOKEN_PATTERN,
  }),
  sessionId: tSafeId("desktopEditSession"),
});

type AcknowledgeDesktopEditHandoffOpenedParams = Static<
  typeof acknowledgeDesktopEditHandoffOpenedParamsSchema
>;
type AcknowledgeDesktopEditHandoffOpenedBody = Static<
  typeof acknowledgeDesktopEditHandoffOpenedBodySchema
>;

type BuildDesktopEditHandoffDeepLinkProps = {
  apiBaseUrl: string;
  handoffToken: string;
};

export const buildDesktopEditHandoffDeepLink = ({
  apiBaseUrl,
  handoffToken,
}: BuildDesktopEditHandoffDeepLinkProps) => {
  const url = new URL("stella://desktop-edit/open");
  url.searchParams.set("handoff", handoffToken);
  url.searchParams.set("apiBaseUrl", apiBaseUrl);
  return url.toString();
};

const createConfig = {
  body: createDesktopEditHandoffBodySchema,
  permissions: { entity: ["update"] },
} satisfies HandlerConfig;

export const createDesktopEditHandoff = createSafeHandler(
  createConfig,
  async function* ({
    body: { entityId, force, linkedAccount, propertyId },
    safeDb,
    user,
    workspaceId,
    recordAuditEvent,
  }) {
    const apiBaseUrl = DESKTOP_EDIT_API_BASE_URL;
    const handoffId = createSafeId<"desktopEditHandoff">();
    const handoffToken = createDesktopEditHandoffToken();
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
  params: desktopEditHandoffStatusParamsSchema,
  permissions: { entity: ["update"] },
} satisfies HandlerConfig;

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
        now: new Date(),
        openedAt: handoff.openedAt,
      }),
    );
  },
);

export const redeemDesktopEditHandoffHandler = async ({
  body: { handoffToken },
  request,
  server,
}: {
  body: { handoffToken: string };
  request: Request;
  server: Parameters<typeof createAuditRecorder>[0]["server"];
}) => {
  const handoff = await consumeDesktopEditHandoff(handoffToken);
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

  if (!access.canUseDesktopEditSession) {
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
      userId: brandPersistedUserId(handoff.createdBy),
      workspaceId: handoff.workspaceId,
    });
  });

  if (Result.isError(result)) {
    const error = result.error;

    if (HandlerError.is(error)) {
      return status(error.status, {
        ...(error.code ? { code: error.code } : {}),
        message: error.message,
      });
    }

    logger.error("Desktop edit handoff redemption failed", {
      "error.type": errorTag(error),
      workspaceId: handoff.workspaceId,
    });

    return status(500, { message: "Internal server error" });
  }

  broadcast(handoff.workspaceId, {
    type: "invalidate-query",
    data: ["entities", handoff.workspaceId],
  });

  return {
    apiBaseUrl: handoff.apiBaseUrl,
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
}: {
  body: AcknowledgeDesktopEditHandoffOpenedBody;
  params: AcknowledgeDesktopEditHandoffOpenedParams;
}) => {
  const acknowledged = await markDesktopEditHandoffOpened({
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
