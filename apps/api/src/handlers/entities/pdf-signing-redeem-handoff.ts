import { Result } from "better-result";

import { env } from "@/api/env";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { redeemPdfSigningHandoff } from "@/api/lib/pdf-signing/sessions";
import { permissiveBodySchema } from "@/api/lib/permissive-route-schema";

const stripTrailingSlashes = (value: string) => {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
};

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: permissiveBodySchema({ keys: ["handoffToken"] }),
} satisfies TokenHandlerConfig;

const redeemPdfSigningHandoffEndpoint = createSafeTokenHandler(
  config,
  async function* ({ body }) {
    const handoffToken = body?.handoffToken;
    const redeemed = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          typeof handoffToken === "string"
            ? await redeemPdfSigningHandoff(handoffToken)
            : null,
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to redeem the signing link.",
            cause,
          }),
      }),
    );

    if (!redeemed) {
      // Unknown, already redeemed, expired and malformed are one answer: the
      // deep link is a bearer credential and must not be probeable.
      return Result.err(
        new HandlerError({
          status: 404,
          message: "This signing link expired or was already used.",
        }),
      );
    }

    return Result.ok({
      apiBaseUrl: stripTrailingSlashes(env.PUBLIC_URL ?? env.BETTER_AUTH_URL),
      documentName: redeemed.documentName,
      expiresAt: redeemed.expiresAt.toISOString(),
      sessionId: redeemed.sessionId,
      sessionToken: redeemed.sessionToken,
      versionNumber: redeemed.versionNumber,
      workspaceName: redeemed.workspaceName,
    });
  },
);

export default redeemPdfSigningHandoffEndpoint;
