import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import cancelPdfSigningSessionFromDesktop from "@/api/handlers/entities/pdf-signing-cancel";
import submitPdfSigningCertificate from "@/api/handlers/entities/pdf-signing-certificate";
import { createRedeemPdfSigningHandoffEndpoint } from "@/api/handlers/entities/pdf-signing-redeem-handoff";
import type { RedeemPdfSigningHandoffDependencies } from "@/api/handlers/entities/pdf-signing-redeem-handoff";
import submitPdfSigningSignature from "@/api/handlers/entities/pdf-signing-signature";
import { routes } from "@/api/http/route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

/**
 * Desktop-facing half of PDF signing. These calls carry a handoff or session
 * token instead of a user session, so they cannot live under the
 * workspace-scoped `/entities/:workspaceId` group. The routes carry the
 * version prefix and the shared API limiter themselves.
 */
export const createPdfSigningSessionsRoute = (
  dependencies?: RedeemPdfSigningHandoffDependencies,
) =>
  routes(
    {
      "/pdf-signing-handoffs/redeem": {
        POST: createRedeemPdfSigningHandoffEndpoint(dependencies),
      },
      "/pdf-signing-sessions/:sessionId/certificate": {
        POST: submitPdfSigningCertificate,
      },
      "/pdf-signing-sessions/:sessionId/signature": {
        POST: submitPdfSigningSignature,
      },
      "/pdf-signing-sessions/:sessionId/cancel": {
        POST: cancelPdfSigningSessionFromDesktop,
      },
    },
    {
      prefix: STELLA_API_VERSION_PREFIX,
      middleware: [rateLimit(createStandardApiRateLimitOptions())],
    },
  );

export const pdfSigningSessionsRoute = createPdfSigningSessionsRoute();
