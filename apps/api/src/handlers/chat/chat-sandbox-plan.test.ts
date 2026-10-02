import { Result } from "better-result";
import { expect, test } from "bun:test";

import { env } from "@/api/env";
import { resolveChatSandboxPlan } from "@/api/handlers/chat/chat-sandbox-plan";
import { toSafeId } from "@/api/lib/branded-types";
import { MANAGED_PROVIDER_UNAVAILABLE_CODE } from "@/api/lib/chat/provider-data-policy";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

test.each(["eu", "us"] as const)(
  "reports unavailable managed sandbox requests for %s",
  async (managedAIResidency) => {
    const previousEnabled = env.AGENT_SANDBOX_RUNS_ENABLED;
    env.AGENT_SANDBOX_RUNS_ENABLED = true;
    try {
      const request = await Result.tryPromise({
        try: async () =>
          await resolveChatSandboxPlan({
            dataClass: "customer",
            managedAIResidency,
            userId: toSafeId<"user">("user_request_policy"),
            organizationId: toSafeId<"organization">("org_request_policy"),
            runId: "run-request-policy",
            workspaceIds: [],
          }),
        catch: (error) => error,
      });
      expect(Result.isError(request)).toBe(true);
      if (Result.isError(request)) {
        expect(request.error).toBeInstanceOf(HandlerError);
        expect(request.error).toMatchObject({
          status: 503,
          code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
        });
      }
    } finally {
      env.AGENT_SANDBOX_RUNS_ENABLED = previousEnabled;
    }
  },
);
