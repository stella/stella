import { expect, test } from "bun:test";

import { env } from "@/api/env";
import { resolveChatSandboxPlan } from "@/api/handlers/chat/chat-sandbox-plan";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

test.each(["eu", "us"] as const)(
  "reports unavailable managed sandbox requests for %s",
  async (managedAIResidency) => {
    const previousEnabled = env.AGENT_SANDBOX_RUNS_ENABLED;
    env.AGENT_SANDBOX_RUNS_ENABLED = true;
    try {
      const request = resolveChatSandboxPlan({
        dataClass: "customer",
        managedAIResidency,
        userId: toSafeId<"user">("user_request_policy"),
        organizationId: toSafeId<"organization">("org_request_policy"),
        runId: "run-request-policy",
        workspaceIds: [],
      });
      await expect(request).rejects.toBeInstanceOf(HandlerError);
      await expect(request).rejects.toMatchObject({
        status: 503,
        code: "managed-provider-unavailable",
      });
    } finally {
      env.AGENT_SANDBOX_RUNS_ENABLED = previousEnabled;
    }
  },
);
