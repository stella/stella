import { describe, expect, test } from "bun:test";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import sendMessage from "./send-message";

type SendMessageCtx = Parameters<typeof sendMessage.handler>[0];

const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-000000000001",
);
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000002");
const threadId = toSafeId<"chatThread">("00000000-0000-0000-0000-000000000003");
const messageId = toSafeId<"chatMessage">(
  "00000000-0000-0000-0000-000000000004",
);
const activeWorkspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000005",
);
const deletingWorkspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000006",
);
const inaccessibleWorkspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000007",
);

const orgAIConfig = {
  providers: [{ provider: "openai", apiKey: "test-api-key" }],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-5.4-mini" },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
  },
} satisfies OrgAIConfig;

const createContext = ({
  contextMatterIds,
}: {
  contextMatterIds: SendMessageCtx["body"]["contextMatterIds"];
}): SendMessageCtx => {
  const { safeDb, scopedDb } = createScopedDbMock({
    query: {
      organizationSettings: {
        findFirst: async () => null,
      },
    },
  });

  return asTestRaw<SendMessageCtx>({
    body: {
      threadId,
      sendMode: CHAT_SEND_MODE.rawOverride,
      contextMatterIds,
      message: {
        id: messageId,
        role: "user",
        parts: [{ type: "text", content: "Summarize the selected matters" }],
      },
    },
    createAuditRecorder: () => async () => {},
    getAccessibleWorkspaces: async () => [
      { id: activeWorkspaceId, status: "active" },
      { id: deletingWorkspaceId, status: "deleting" },
    ],
    getActiveWorkspaceIds: async () => [activeWorkspaceId],
    getWorkspaceAccess: async () => null,
    memberRole: { role: "owner" },
    orgAIConfig,
    pinServerValidatedWorkspaceId: () => false,
    promptCachingEnabled: false,
    recordAuditEvent: async () => {},
    request: new Request("http://localhost/v1/chat/send"),
    route: "/v1/chat/send",
    safeDb,
    scopedDb,
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
  });
};

describe("send message context-matter authorization", () => {
  test("rejects a requested matter outside the caller's accessible set", async () => {
    const result = await sendMessage.handler(
      createContext({ contextMatterIds: [inaccessibleWorkspaceId] }),
    );

    expect(result).toEqual({
      code: 403,
      response: { message: "contextMatterIds includes inaccessible matter" },
    });
  });

  test("treats a deleting matter as inaccessible even when membership still resolves", async () => {
    const result = await sendMessage.handler(
      createContext({ contextMatterIds: [deletingWorkspaceId] }),
    );

    expect(result).toEqual({
      code: 403,
      response: { message: "contextMatterIds includes inaccessible matter" },
    });
  });
});
