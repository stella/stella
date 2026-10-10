import { describe, expect, test } from "bun:test";

import { sha256Hex } from "@stll/sha256/bun";

import { env } from "@/api/env";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { createProposeMessageSpanEdit } from "@/api/handlers/chat/messages/revisions/span-edit";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

const state = createTestState({ file: import.meta.path, config: env });
const organizationId = toSafeId<"organization">("org_span");
const userId = toSafeId<"user">("user_span");
const threadId = toSafeId<"chatThread">("thread_span");
const messageId = toSafeId<"chatMessage">("message_span");
const orgAIConfig = {
  providers: [{ provider: "openai" as const, apiKey: "offline-key" }],
  overrideModels: {
    chat: { provider: "openai" as const, modelId: "gpt-5.4-mini" },
    fast: { provider: "openai" as const, modelId: "gpt-5.4-nano" },
    pdf: { provider: "openai" as const, modelId: "gpt-5.4" },
    reasoning: { provider: "openai" as const, modelId: "gpt-5.4" },
  },
  decision: null,
};

const runProposal = async ({
  revision = 0,
  baseRevision = 0,
  hash = sha256Hex("old"),
  instruction = "Rewrite",
  anonymized = false,
  active = false,
  replacement = "new",
} = {}) => {
  state.patchConfig({
    FEATURE_ACTION_ADMISSION: false,
    USAGE_ENFORCEMENT_ENABLED: false,
    REQUIRE_PERSONAL_AI_KEY: false,
  });
  let modelCalls = 0;
  const db = createScopedDbMock({
    select: (fields: Record<string, unknown>) => {
      if ("message" in fields) {
        return createSelectQueryMock([
          {
            message: {
              id: messageId,
              role: "assistant",
              revision,
              content: toPersistedChatMessageContentV3({
                data: [{ type: "text", content: "The old answer." }],
              }),
            },
            thread: {
              workspaceId: null,
              dataWorkspaceIds: [],
              chatModel: "openai::gpt-5.4-mini",
              chatReasoningEffort: null,
            },
          },
        ]);
      }
      if ("usedAnonymization" in fields) {
        return createSelectQueryMock([{ usedAnonymization: anonymized }]);
      }
      return createSelectQueryMock(active ? [{ id: "active-turn" }] : []);
    },
  });
  const endpoint = createProposeMessageSpanEdit({
    generateObject: async (options) => {
      modelCalls += 1;
      expect(options.modelId).toBe("openai::gpt-5.4-mini");
      expect(options.managedAIResidency).toBe("eu");
      expect(options.orgAIConfig).toEqual(orgAIConfig);
      return { replacement };
    },
  });
  const result = await endpoint.handler(
    asTestRaw<Parameters<typeof endpoint.handler>[0]>({
      body: {
        baseRevision,
        start: 4,
        end: 7,
        selectedTextHash: hash,
        instruction,
      },
      params: { threadId, messageId },
      safeDb: db.safeDb,
      scopedDb: db.scopedDb,
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
      orgAIConfig,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      managedAIResidency: "eu",
      memberRole: sessionMemberRole("owner"),
      promptCachingEnabled: false,
      request: new Request("https://example.test/chat/span-edit"),
      route: "/chat/span-edit",
    }),
  );
  return { result, modelCalls };
};

describe("answer rewrite endpoint", () => {
  test("returns an anchored proposal through the selected model without persistence", async () => {
    const { result, modelCalls } = await runProposal();
    expect(modelCalls).toBe(1);
    expect(result).toMatchObject({
      content: {
        version: 3,
        data: [{ type: "text", content: "The new answer." }],
      },
      replacement: "new",
      edit: {
        type: "ai_span",
        start: 4,
        end: 7,
        model: "gpt-5.4-mini",
        keySource: "byok",
      },
    });
  });
  test.each([
    { options: { revision: 1 }, status: 409 },
    { options: { hash: sha256Hex("wrong") }, status: 409 },
    { options: { active: true }, status: 409 },
    { options: { anonymized: true }, status: 403 },
    { options: { instruction: "   " }, status: 400 },
  ])(
    "refuses invalid anchor or policy with status $status before dispatch",
    async ({ options, status }) => {
      const { result, modelCalls } = await runProposal(options);
      expect(modelCalls).toBe(0);
      expect(result).toMatchObject({ status });
    },
  );
  test("surfaces malformed model Markdown as a retryable proposal failure", async () => {
    const { result, modelCalls } = await runProposal({ replacement: "**open" });
    expect(modelCalls).toBe(1);
    expect(result).toMatchObject({ status: 502 });
  });
});
