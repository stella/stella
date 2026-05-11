import { Result } from "better-result";
import Elysia, { status, t } from "elysia";

import {
  PROVIDER_PROBE_VALUES,
  probeProvider,
} from "@/api/lib/ai-provider-probe";
import { getSessionAndMemberRole } from "@/api/lib/auth";
import { logger } from "@/api/lib/observability/logger";

/**
 * Authenticated, org-agnostic AI provider key health-check.
 * Onboarding users have no active organization yet, so this
 * route checks only that a valid session+user exists — it does
 * not require an active org or any role permission.
 */
export const aiConfigPublicRoute = new Elysia({ prefix: "/ai-config" }).post(
  "/validate-provider",
  async ({ body, request }) => {
    const { sessionResult } = await getSessionAndMemberRole(request.headers);
    if (Result.isError(sessionResult)) {
      return status(500);
    }
    const session = sessionResult.value?.session;
    const user = sessionResult.value?.user;
    if (!session || !user) {
      return status(401);
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
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.warn("ai_config.provider_validation_unreachable", {
        provider: body.provider,
      });
      return status(502, { message });
    }
  },
  {
    body: t.Object({
      provider: t.UnionEnum(PROVIDER_PROBE_VALUES),
      apiKey: t.String({ minLength: 1, maxLength: 512 }),
      endpoint: t.Optional(t.String({ minLength: 1, maxLength: 2048 })),
      apiVersion: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
      region: t.Optional(t.UnionEnum(["eu", "global", "ch"])),
    }),
  },
);
