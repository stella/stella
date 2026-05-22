import { Result } from "better-result";
import { t } from "elysia";

import {
  PROVIDER_PROBE_VALUES,
  probeProvider,
} from "@/api/lib/ai-provider-probe";
import { createSafeSessionHandler } from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";

const MAX_PROBE_ERROR_DETAIL_LEN = 200;

export const validateProviderBody = t.Object({
  provider: t.UnionEnum(PROVIDER_PROBE_VALUES),
  apiKey: t.String({ minLength: 1, maxLength: 512 }),
  endpoint: t.Optional(t.String({ minLength: 1, maxLength: 2048 })),
  apiVersion: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  region: t.Optional(t.UnionEnum(["eu", "global", "ch"])),
});

const config = {
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
 * addresses, so the user-supplied Azure `endpoint` cannot reach
 * private targets.
 */
const validateProvider = createSafeSessionHandler(
  config,
  async function* ({ body }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await probeProvider(
            body.provider,
            body.apiKey,
            body.endpoint,
            body.apiVersion,
          ),
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
