import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { createTestState } from "@/api/tests/helpers/test-state";

import readAIAvailability from "./get";

const testState = createTestState({ file: import.meta.path, config: env });

type ReadContext = Parameters<typeof readAIAvailability.handler>[0];

type InstanceProvider = "provisioned" | "absent";

const ORG_AI_CONFIG: OrgAIConfig = {
  providers: [{ apiKey: "test-openai-org-key", provider: "openai" }],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-5.4-mini" },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
  },
  decision: null,
};

const readAvailability = async (
  orgAIConfigStatus: OrgAIConfigStatus,
  instanceProvider: InstanceProvider,
  orgAIConfig: OrgAIConfig | null = null,
  identity?: {
    email: string;
    role: "member" | "owner";
  },
) => {
  testState.patchConfig({
    AI_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "test-openrouter-instance-key",
    REQUIRE_PERSONAL_AI_KEY: instanceProvider === "absent",
  });
  const result = await readAIAvailability.handler(
    createTestHandlerContext<ReadContext>({
      audit: NO_AUDIT,
      safeDb: NO_DB,
      scopedDb: NO_DB,
      orgAIConfig,
      orgAIConfigStatus,
      ...(identity === undefined
        ? {}
        : {
            memberRole: sessionMemberRole(identity.role),
            user: { email: identity.email },
          }),
    }),
  );
  if ("code" in result) {
    throw new Error(`Expected availability, got status ${result.code}`);
  }
  return result;
};

describe("AI availability on an instance with a provider", () => {
  test("reports AI available to an org the instance provider serves", async () => {
    const availability = await readAvailability(
      ORG_AI_CONFIG_STATUS.ok,
      "provisioned",
    );

    expect(availability.instanceProvisioned).toBe(true);
    expect(availability.available).toBe(true);
    expect(availability.unavailableReason).toBeNull();
  });

  test.each([
    ORG_AI_CONFIG_STATUS.ownKeyRequired,
    ORG_AI_CONFIG_STATUS.memberAssignmentRequired,
    ORG_AI_CONFIG_STATUS.unreadable,
  ])(
    "reports AI unavailable when every AI call would refuse with %s",
    async (status) => {
      const availability = await readAvailability(status, "provisioned");

      expect(availability.instanceProvisioned).toBe(true);
      expect(availability.available).toBe(false);
    },
  );
});

describe("AI availability on an instance without a provider", () => {
  test("reports AI unavailable to an org with no key of its own", async () => {
    const availability = await readAvailability(
      ORG_AI_CONFIG_STATUS.ok,
      "absent",
    );

    expect(availability.instanceProvisioned).toBe(false);
    expect(availability.orgConfigured).toBe(false);
    expect(availability.available).toBe(false);
    expect(availability.unavailableReason).toBe("provider_not_configured");
    expect(availability.providerConfiguration).toBe("allowed");
  });

  test("requires organization-settings permission to configure a provider", async () => {
    const availability = await readAvailability(
      ORG_AI_CONFIG_STATUS.ok,
      "absent",
      null,
      { email: "member@example.test", role: "member" },
    );

    expect(availability.providerConfiguration).toBe("permission_required");
  });

  test("refuses provider configuration for the restricted review owner", async () => {
    testState.patchConfig({
      APP_REVIEW_ACCOUNT_EMAIL: "review@example.test",
      APP_REVIEW_ORGANIZATION_ID: "org_test",
    });
    const availability = await readAvailability(
      ORG_AI_CONFIG_STATUS.ok,
      "absent",
      null,
      { email: "review@example.test", role: "owner" },
    );

    expect(availability.providerConfiguration).toBe("account_restricted");
  });
});

describe("AI availability to an org with its own key", () => {
  test("reports AI available without an instance provider", async () => {
    const availability = await readAvailability(
      ORG_AI_CONFIG_STATUS.ok,
      "absent",
      ORG_AI_CONFIG,
    );

    expect(availability.orgConfigured).toBe(true);
    expect(availability.available).toBe(true);
  });

  // An unreadable config reaches handlers as a null config, so a member
  // without a seat is the only refusal that coexists with the org's own key.
  test("reports AI unavailable to a member without a seat", async () => {
    const availability = await readAvailability(
      ORG_AI_CONFIG_STATUS.memberAssignmentRequired,
      "provisioned",
      ORG_AI_CONFIG,
    );

    expect(availability.orgConfigured).toBe(true);
    expect(availability.available).toBe(false);
  });
});
