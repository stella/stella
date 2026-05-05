import { Result } from "better-result";
import Elysia, { status, t } from "elysia";

import {
  PROVIDER_PROBE_VALUES,
  probeProvider,
} from "@/api/lib/ai-provider-probe";
import { getSessionAndMemberRole } from "@/api/lib/auth";

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
      const result = await probeProvider(body.provider, body.apiKey);
      if (!result.valid) {
        console.warn(
          `[validate-ai-provider] ${body.provider} rejected:`,
          result.error,
        );
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.warn(
        `[validate-ai-provider] ${body.provider} unreachable:`,
        message,
      );
      return status(502, { message });
    }
  },
  {
    body: t.Object({
      provider: t.UnionEnum(PROVIDER_PROBE_VALUES),
      apiKey: t.String({ minLength: 1, maxLength: 512 }),
      region: t.Optional(t.UnionEnum(["eu", "global", "ch"])),
    }),
  },
);
