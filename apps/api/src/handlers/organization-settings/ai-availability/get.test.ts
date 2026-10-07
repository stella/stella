import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

import readAIAvailability from "./get";

type ReadContext = Parameters<typeof readAIAvailability.handler>[0];

const readAvailability = async (orgAIConfigStatus: OrgAIConfigStatus) => {
  const previous = {
    AI_PROVIDER: env.AI_PROVIDER,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
  };
  env.AI_PROVIDER = "openrouter";
  env.OPENROUTER_API_KEY = "test-openrouter-instance-key";
  try {
    const result = await readAIAvailability.handler(
      createTestHandlerContext<ReadContext>({ orgAIConfigStatus }),
    );
    if ("code" in result) {
      throw new Error(`Expected availability, got status ${result.code}`);
    }
    return result;
  } finally {
    env.AI_PROVIDER = previous.AI_PROVIDER;
    env.OPENROUTER_API_KEY = previous.OPENROUTER_API_KEY;
  }
};

describe("AI availability on an instance with a provider", () => {
  test("reports AI available to an org the instance provider serves", async () => {
    const availability = await readAvailability(ORG_AI_CONFIG_STATUS.ok);

    expect(availability.instanceProvisioned).toBe(true);
    expect(availability.available).toBe(true);
  });

  test.each([
    ORG_AI_CONFIG_STATUS.ownKeyRequired,
    ORG_AI_CONFIG_STATUS.memberAssignmentRequired,
    ORG_AI_CONFIG_STATUS.unreadable,
  ])(
    "reports AI unavailable when every AI call would refuse with %s",
    async (status) => {
      const availability = await readAvailability(status);

      expect(availability.instanceProvisioned).toBe(true);
      expect(availability.available).toBe(false);
    },
  );
});
