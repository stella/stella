import { Result } from "better-result";
import * as v from "valibot";

import { PDF_SIGNING_SESSION_CLOSE_REASONS } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { closePdfSigningSession } from "@/api/lib/files/pdf-signing/close-session";

import {
  pdfSigningSessionParamsSchema,
  pdfSigningSessionTokenSchema,
  verifyPdfSigningCaller,
} from "./pdf-signing-credentials";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: v.object({
    sessionToken: pdfSigningSessionTokenSchema,
    reason: v.picklist(PDF_SIGNING_SESSION_CLOSE_REASONS),
  }),
  params: pdfSigningSessionParamsSchema,
} satisfies TokenHandlerConfig;

const cancelPdfSigningSessionFromDesktop = createSafeTokenHandler(
  config,
  verifyPdfSigningCaller,
  async function* ({ body, caller: session, request, server }) {
    yield* Result.await(
      closePdfSigningSession({
        closeReason: body.reason,
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
