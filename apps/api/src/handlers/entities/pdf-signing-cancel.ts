import { Result } from "better-result";
import { t } from "elysia";

import { PDF_SIGNING_SESSION_CLOSE_REASONS } from "@/api/db/schema";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { closePdfSigningSession } from "@/api/lib/files/pdf-signing/close-session";
import {
  permissiveBodySchema,
  permissiveRouteSchema,
  validatePostAuth,
} from "@/api/lib/permissive-route-schema";

import { authorizePdfSigningCredentials } from "./pdf-signing-credentials";

const cancelPayloadSchema = t.Object({
  reason: t.UnionEnum(PDF_SIGNING_SESSION_CLOSE_REASONS),
});

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: permissiveBodySchema({ keys: ["sessionToken", "reason"] }),
  params: permissiveRouteSchema({ keys: ["sessionId"] }),
} satisfies TokenHandlerConfig;

const cancelPdfSigningSessionFromDesktop = createSafeTokenHandler(
  config,
  async function* ({ body, params, request, server }) {
    const session = yield* Result.await(
      authorizePdfSigningCredentials({
        sessionId: params.sessionId,
        sessionToken: body?.sessionToken,
      }),
    );

    const payload = validatePostAuth(cancelPayloadSchema, body);
    if (!payload.ok) {
      return Result.err(
        new HandlerError({ status: 400, message: payload.message }),
      );
    }

    yield* Result.await(
      closePdfSigningSession({
        closeReason: payload.value.reason,
        recordAuditEvent: createAuditRecorder({
          organizationId: session.organizationId,
          workspaceId: session.workspaceId,
          userId: session.userId,
          request,
          server,
        }),
        safeDb: session.safeDb,
        sessionId: session.sessionId,
      }),
    );

    return Result.ok({ status: "cancelled" as const });
  },
);

export default cancelPdfSigningSessionFromDesktop;
