import { Result } from "better-result";

import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { getAuth } from "@/api/lib/auth";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { permissiveBodySchema } from "@/api/lib/permissive-route-schema";
import {
  findActiveInvitation,
  isShareInvitationSecret,
  normalizeRecipientEmail,
} from "@/api/lib/share-space-access";

const config = {
  body: permissiveBodySchema({ keys: ["invitationSecret", "email"] }),
  mcp: { type: "internal", reason: "auth_plumbing" },
} satisfies TokenHandlerConfig;

const requestShareOtp = createSafeTokenHandler(
  config,
  async function* ({ body, request }) {
    const invitationSecret = body?.invitationSecret;
    const emailNormalized = normalizeRecipientEmail(body?.email);

    // Deliberately return the same response for malformed, unknown, expired,
    // revoked, and wrong-email invitations. This endpoint must not become an
    // invitation or recipient-enumeration oracle.
    if (!isShareInvitationSecret(invitationSecret) || !emailNormalized) {
      return Result.ok({ accepted: true as const });
    }

    const invitation = yield* Result.await(
      Result.tryPromise(
        async () =>
          await findActiveInvitation({ invitationSecret, emailNormalized }),
      ),
    );
    if (!invitation) {
      return Result.ok({ accepted: true as const });
    }

    const sendResult = await Result.tryPromise(
      async () =>
        await getAuth().api.sendVerificationOTP({
          body: { email: emailNormalized, type: "sign-in" },
          headers: request.headers,
        }),
    );
    if (Result.isError(sendResult)) {
      // Preserve the generic response while retaining non-sensitive telemetry.
      logger.warn("share_space.otp_send_failed", {
        "error.type": errorTag(sendResult.error),
      });
    }

    return Result.ok({ accepted: true as const });
  },
);

export default requestShareOtp;
