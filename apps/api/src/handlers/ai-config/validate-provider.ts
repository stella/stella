import { Result } from "better-result";
import { status, t } from "elysia";

import {
  PROVIDER_PROBE_VALUES,
  probeProvider,
} from "@/api/lib/ai-provider-probe";
import { getSessionAndMemberRole } from "@/api/lib/auth";
import { logger } from "@/api/lib/observability/logger";

const MAX_PROBE_ERROR_DETAIL_LEN = 200;

export const validateProviderBody = t.Object({
  provider: t.UnionEnum(PROVIDER_PROBE_VALUES),
  apiKey: t.String({ minLength: 1, maxLength: 512 }),
  endpoint: t.Optional(t.String({ minLength: 1, maxLength: 2048 })),
  apiVersion: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  region: t.Optional(t.UnionEnum(["eu", "global", "ch"])),
});

type ValidateProviderBody = (typeof validateProviderBody)["static"];

/**
 * Authenticated, org-agnostic AI provider key health-check. The
 * onboarding flow calls this before the user has an active
 * organization, so the gate is "valid session + user" rather than
 * a permission scope. The provider probe goes through
 * `safeOutboundFetchBytes`, which resolves DNS and pins resolved
 * addresses, so the user-supplied Azure `endpoint` cannot reach
 * private targets.
 */
export const handleValidateProvider = async ({
  body,
  request,
}: {
  body: ValidateProviderBody;
  request: Request;
}) => {
  const { sessionResult } = await getSessionAndMemberRole(request.headers);
  if (Result.isError(sessionResult)) {
    return status(500, { message: "Internal server error" });
  }
  const session = sessionResult.value?.session;
  const user = sessionResult.value?.user;
  if (!session || !user) {
    return status(401, { message: "Unauthorized" });
  }

  try {
    const result = await probeProvider(
      body.provider,
      body.apiKey,
      body.endpoint,
      body.apiVersion,
    );
    if (!result.valid) {
      logger.warn("ai_config.provider_validation_rejected", {
        provider: body.provider,
      });
      if (result.error && result.error.length > MAX_PROBE_ERROR_DETAIL_LEN) {
        return {
          valid: false as const,
          error: result.error.slice(0, MAX_PROBE_ERROR_DETAIL_LEN),
        };
      }
    }
    return result;
  } catch (error) {
    const raw = error instanceof Error ? error.message : "Unknown error";
    const message =
      raw.length > MAX_PROBE_ERROR_DETAIL_LEN
        ? raw.slice(0, MAX_PROBE_ERROR_DETAIL_LEN)
        : raw;
    logger.warn("ai_config.provider_validation_unreachable", {
      provider: body.provider,
    });
    return status(502, { message });
  }
};
