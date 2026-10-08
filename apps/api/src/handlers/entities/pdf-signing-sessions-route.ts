import Elysia from "elysia";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import cancelPdfSigningSessionFromDesktop from "@/api/handlers/entities/pdf-signing-cancel";
import submitPdfSigningCertificate from "@/api/handlers/entities/pdf-signing-certificate";
import { createRedeemPdfSigningHandoffEndpoint } from "@/api/handlers/entities/pdf-signing-redeem-handoff";
import type { RedeemPdfSigningHandoffDependencies } from "@/api/handlers/entities/pdf-signing-redeem-handoff";
import submitPdfSigningSignature from "@/api/handlers/entities/pdf-signing-signature";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

/**
 * Desktop-facing half of PDF signing. These calls carry a handoff or session
 * token instead of a user session, so they cannot live under the
 * workspace-scoped `/entities/:workspaceId` group. The route is mounted
 * outside the `/v1` group in `server.ts` (Eden type depth) and therefore
 * carries the version prefix and the shared API limiter itself.
 */
export const createPdfSigningSessionsRoute = (
  dependencies?: RedeemPdfSigningHandoffDependencies,
) => {
  const redeemPdfSigningHandoff =
    createRedeemPdfSigningHandoffEndpoint(dependencies);
  return new Elysia({
    prefix: STELLA_API_VERSION_PREFIX,
  })
    .use(rateLimit(createStandardApiRateLimitOptions()))
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
};

export const pdfSigningSessionsRoute = createPdfSigningSessionsRoute();
