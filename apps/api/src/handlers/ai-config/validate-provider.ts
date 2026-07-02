import { Result } from "better-result";
import { t } from "elysia";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";

import { probeProvider } from "@/api/lib/ai-provider-probe";
import { createSafeSessionHandler } from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";

const MAX_PROBE_ERROR_DETAIL_LEN = 200;

export const validateProviderBody = t.Object({
  provider: t.UnionEnum(TANSTACK_AI_PROVIDERS),
  apiKey: t.String({ minLength: 1, maxLength: 512 }),
  region: t.Optional(t.Literal("global")),
});

const config = {
  mcp: { type: "pending" },
  body: validateProviderBody,
} satisfies SessionHandlerConfig;

const truncateProbeError = (message: string): string =>
  message.length > MAX_PROBE_ERROR_DETAIL_LEN
    ? message.slice(0, MAX_PROBE_ERROR_DETAIL_LEN)
    : message;

/**
 * Authenticated, org-agnostic AI provider key health-check. The
 * onboarding flow calls this before the user has an active
 * organization, so the gate is "valid session + user" rather than
 * a permission scope. The provider probe goes through
 * `safeOutboundFetchBytes`, which resolves DNS and pins resolved
 * addresses, so user-supplied Azure/Hugging Face endpoints cannot
 * reach private targets.
 */
const validateProvider = createSafeSessionHandler(
  config,
  async function* ({ body }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await probeProvider(body.provider, body.apiKey, undefined, undefined),
        catch: (error: unknown) => {
          const raw = error instanceof Error ? error.message : "Unknown error";
          logger.warn("ai_config.provider_validation_unreachable", {
            provider: body.provider,
          });
          return new HandlerError({
            status: 502,
            message: truncateProbeError(raw),
            cause: error,
          });
        },
      }),
    );

    if (!result.valid) {
      logger.warn("ai_config.provider_validation_rejected", {
        provider: body.provider,
      });
      if (result.error && result.error.length > MAX_PROBE_ERROR_DETAIL_LEN) {
        return Result.ok({
          valid: false as const,
          error: truncateProbeError(result.error),
        });
      }
    }

    return Result.ok(result);
  },
);

export default validateProvider;
