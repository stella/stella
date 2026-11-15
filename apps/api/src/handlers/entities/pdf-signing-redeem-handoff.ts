import type { InferOk } from "better-result";
import { Result } from "better-result";
import * as v from "valibot";

import { env } from "@/api/env";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import type { TokenHandlerConfig, VerifyCaller } from "@/api/lib/api-handlers";
import { authorizeDesktopHandoff } from "@/api/lib/business-registries/desktop/handoff-auth";
import type { DesktopHandoffAuthorizationDependencies } from "@/api/lib/business-registries/desktop/handoff-auth";
import { isOpaqueTokenShape } from "@/api/lib/entities/opaque-tokens";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { redeemPdfSigningHandoff } from "@/api/lib/files/pdf-signing/sessions";
import type { TokenScopedDatabase } from "@/api/lib/root-scoped-db";
import { tokenScopedDatabase } from "@/api/lib/root-scoped-db";
import { isRecord } from "@/api/lib/type-guards";

const stripTrailingSlashes = (value: string) => {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
};

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: v.object({
    handoffToken: v.pipe(v.string(), v.check(isOpaqueTokenShape)),
  }),
} satisfies TokenHandlerConfig;

export type RedeemPdfSigningHandoffDependencies =
  DesktopHandoffAuthorizationDependencies & {
    redemptionDatabase?: TokenScopedDatabase;
  };

type RedeemedPdfSigningHandoff = {
  identity: InferOk<Awaited<ReturnType<typeof authorizeDesktopHandoff>>>;
  redeemed: NonNullable<Awaited<ReturnType<typeof redeemPdfSigningHandoff>>>;
};

/**
 * The caller proves itself twice: the linked desktop account, then the
 * one-time deep link it redeems. Redeeming is the deep link's check, so it
 * happens here, before anything reads the body's shape.
 */
const verifyHandoffCaller =
  (
    dependencies: RedeemPdfSigningHandoffDependencies | undefined,
  ): VerifyCaller<RedeemedPdfSigningHandoff> =>
  async ({ request, body }) => {
    const handoffToken = isRecord(body) ? body["handoffToken"] : undefined;
    const identity = await authorizeDesktopHandoff(
      { request, handoffToken, kind: "pdf_signing" },
      dependencies,
    );
    if (Result.isError(identity)) {
      return Result.err(identity.error);
    }
    const redeemed = await Result.tryPromise({
      try: async () =>
        typeof handoffToken === "string"
          ? await redeemPdfSigningHandoff(
              handoffToken,
              dependencies?.redemptionDatabase ?? tokenScopedDatabase,
              { identity: identity.value },
            )
          : null,
      catch: (cause) =>
        new HandlerError({
          status: 500,
          message: "Failed to redeem the signing link.",
          cause,
        }),
    });
    if (Result.isError(redeemed)) {
      return Result.err(redeemed.error);
    }
    if (!redeemed.value) {
      // Unknown, already redeemed, expired and malformed are one answer: the
      // deep link is a bearer credential and must not be probeable.
      return Result.err(
        new HandlerError({
          status: 404,
          message: "This signing link expired or was already used.",
        }),
      );
    }
    return Result.ok({ identity: identity.value, redeemed: redeemed.value });
  };

export const createRedeemPdfSigningHandoffEndpoint = (
  dependencies?: RedeemPdfSigningHandoffDependencies,
) =>
  createSafeTokenHandler(
    config,
    verifyHandoffCaller(dependencies),
    // oxlint-disable-next-line typescript/require-await -- safe handlers must remain async generators for Result.gen error capture.
    async function* ({ caller }) {
      const { identity, redeemed } = yield* Result.ok(caller);
      return Result.ok({
        apiBaseUrl: stripTrailingSlashes(env.PUBLIC_URL ?? env.BETTER_AUTH_URL),
        identity: {
          userId: identity.userId,
          organizationId: identity.organizationId,
        },
        documentName: redeemed.documentName,
        expiresAt: redeemed.expiresAt.toISOString(),
        sessionId: redeemed.sessionId,
        sessionToken: redeemed.sessionToken,
        stampPageNumber: redeemed.stampPageNumber,
        versionNumber: redeemed.versionNumber,
        workspaceName: redeemed.workspaceName,
      });
    },
  );

export default createRedeemPdfSigningHandoffEndpoint();
