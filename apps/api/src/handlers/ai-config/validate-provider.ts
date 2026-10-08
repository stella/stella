import { Result } from "better-result";
import { t } from "elysia";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";

import { consumeValidateProviderRateLimit } from "@/api/handlers/ai-config/validate-provider-rate-limit";
import { supportsRegion } from "@/api/lib/ai-config";
import { probeProvider } from "@/api/lib/ai-provider-probe";
import { ANTHROPIC_WORKSPACE_ID_PATTERN } from "@/api/lib/anthropic-config";
import {
  ACCOUNT_ACCESS,
  createSafeSessionHandler,
} from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { isActiveOrganizationMember } from "@/api/lib/auth";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";

export const validateProviderBody = t.Object({
  provider: t.UnionEnum(TANSTACK_AI_PROVIDERS),
  apiKey: t.String({ minLength: 1, maxLength: 512 }),
  anthropicWorkspaceId: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 256,
      pattern: ANTHROPIC_WORKSPACE_ID_PATTERN,
    }),
  ),
  region: t.Optional(
    t.Union([t.Literal("global"), t.Literal("eu"), t.Literal("ch")]),
  ),
});

const config = {
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
  body: validateProviderBody,
} satisfies SessionHandlerConfig;

/** Preflight failure the caller cannot act on (Redis, session, or member read). */
const probeUnavailable = (error: unknown): HandlerError =>
  new HandlerError({
    status: 500,
    message: "Could not validate the provider key",
    cause: error,
  });

/**
 * Authenticated AI provider key health-check. The onboarding flow
 * calls this before the user has an active organization, so the gate
 * is a valid session plus membership of whatever organization the
 * session is scoped to, rather than a permission scope. Each call
 * makes an outbound request to the vendor with caller-supplied
 * credentials, so it carries its own per-user budget. The provider
 * probe goes through `safeOutboundFetchBytes`, which resolves DNS and
 * pins resolved addresses, so user-supplied Azure/Hugging Face
 * endpoints cannot reach private targets.
 */
const validateProvider = createSafeSessionHandler(
  config,
  async function* ({ body, request, set, user }) {
    if (
      body.anthropicWorkspaceId !== undefined &&
      body.provider !== "anthropic"
    ) {
      return Result.err(
        new HandlerError({
          code: "ai_config_provider_invalid",
          status: 400,
          message: "Workspace ID is supported only for Anthropic",
        }),
      );
    }
    if (
      body.region &&
      body.region !== "global" &&
      !supportsRegion(body.provider)
    ) {
      return Result.err(
        new HandlerError({
          code: "ai_config_provider_invalid",
          status: 400,
          message: `The selected endpoint setting is not supported by ${body.provider}. Use global.`,
        }),
      );
    }

    const withinBudget = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await consumeValidateProviderRateLimit({ userId: user.id }),
        catch: probeUnavailable,
      }),
    );
    if (!withinBudget) {
      return Result.err(
        new HandlerError({
          status: 429,
          message: "Too many provider checks. Try again in a minute.",
        }),
      );
    }

    const isMember = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await isActiveOrganizationMember({
            headers: request.headers,
            responseHeaders: set.headers,
            userId: user.id,
          }),
        catch: probeUnavailable,
      }),
    );
    if (!isMember) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Organization membership required",
        }),
      );
    }

    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await probeProvider({
            apiKey: body.apiKey,
            anthropicWorkspaceId: body.anthropicWorkspaceId,
            permit: grantThirdPartyOutboundPermit(),
            provider: body.provider,
          }),
        catch: (error: unknown) => {
          const raw = error instanceof Error ? error.message : "Unknown error";
          logger.warn("ai_config.provider_validation_unreachable", {
            provider: body.provider,
          });
          return new HandlerError({
            status: 502,
            message: raw,
            cause: error,
          });
        },
      }),
    );

    if (!result.valid) {
      logger.warn("ai_config.provider_validation_rejected", {
        provider: body.provider,
      });
    }

    return Result.ok(result);
  },
);

export default validateProvider;
