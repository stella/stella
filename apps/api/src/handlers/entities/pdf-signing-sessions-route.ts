import Elysia from "elysia";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import cancelPdfSigningSessionFromDesktop from "@/api/handlers/entities/pdf-signing-cancel";
import submitPdfSigningCertificate from "@/api/handlers/entities/pdf-signing-certificate";
import redeemPdfSigningHandoff from "@/api/handlers/entities/pdf-signing-redeem-handoff";
import submitPdfSigningSignature from "@/api/handlers/entities/pdf-signing-signature";

/**
 * Desktop-facing half of PDF signing. These calls carry a handoff or session
 * token instead of a user session, so they cannot live under the
 * workspace-scoped `/entities/:workspaceId` group. The route is mounted
 * outside the `/v1` group in `server.ts` (Eden type depth) and therefore
 * carries the version prefix itself.
 */
export const pdfSigningSessionsRoute = new Elysia({
  prefix: STELLA_API_VERSION_PREFIX,
})
  .post("/pdf-signing-handoffs/redeem", redeemPdfSigningHandoff.handler, {
    body: redeemPdfSigningHandoff.config.body,
  })
  .post(
    "/pdf-signing-sessions/:sessionId/certificate",
    submitPdfSigningCertificate.handler,
    {
      body: submitPdfSigningCertificate.config.body,
      params: submitPdfSigningCertificate.config.params,
    },
  )
  .post(
    "/pdf-signing-sessions/:sessionId/signature",
    submitPdfSigningSignature.handler,
    {
      body: submitPdfSigningSignature.config.body,
      params: submitPdfSigningSignature.config.params,
    },
  )
  .post(
    "/pdf-signing-sessions/:sessionId/cancel",
    cancelPdfSigningSessionFromDesktop.handler,
    {
      body: cancelPdfSigningSessionFromDesktop.config.body,
      params: cancelPdfSigningSessionFromDesktop.config.params,
    },
  );
