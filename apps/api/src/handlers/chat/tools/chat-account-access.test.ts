import { describe, expect, test } from "bun:test";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { getChatTools } from "@/api/handlers/chat/tools/chat-tools";
import { PAST_CHAT_SCOPE_TYPE } from "@/api/handlers/chat/tools/past-chat-tools";
import { toSafeId } from "@/api/lib/branded-types";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";

const DEMO_EMAIL = "limited@example.test";

const workspaceId = toSafeId<"workspace">(
  "33333333-3333-4333-8333-333333333333",
);

const unusedScopedDb: ScopedDb = async () => {
  throw new Error("This test only constructs tool sets.");
};
const unusedSafeDb: SafeDb = async () => {
  throw new Error("This test only constructs tool sets.");
};

const registeredToolNames = (userEmail: string) =>
  Object.entries(
    getChatTools({
      activeSkillContext: null,
      docxSuggestionSurface: "file-overlay",
      editApplyMode: "manual",
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      memberRole: sessionMemberRole("owner"),
      memoryEnabled: false,
      organizationId: toSafeId<"organization">(
        "11111111-1111-4111-8111-111111111111",
      ),
      orgAIConfig: null,
      managedAIResidency: "eu",
      pinServerValidatedWorkspaceId: () => true,
      refRegistry: createChatRefRegistry(),
      registryDispatch: BUSINESS_REGISTRY_DISPATCH,
      requestWorkspaceId: workspaceId,
      resolveMemorySourceWorkspaceIds: () => [],
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      thirdPartyBoundary: { type: "raw" },
      threadId: toSafeId<"chatThread">("55555555-5555-4555-8555-555555555555"),
      toolDefectMemo: createChatToolDefectMemo(),
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
      userId: toSafeId<"user">("22222222-2222-4222-8222-222222222222"),
      userEmail,
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      workspaceId,
      workspaceStatusById: new Map([[workspaceId, "active"]]),
      pastChatScope: { type: PAST_CHAT_SCOPE_TYPE.allChats },
    }),
  ).flatMap(([name, tool]) => (tool === undefined ? [] : [name]));

const standardWriteToolNames = new Set(
  listStaticMcpToolDefinitions().flatMap((definition) =>
    definition.access === "write" && definition.accountAccess === "standard"
      ? [definition.name]
      : [],
  ),
);

describe("chat account access", () => {
  // Hand-written chat tools share names with MCP definitions; each must honour
  // the declared account access, not only its own registration gate.
  test("the demo account is offered no tool its MCP definition declares standard", () => {
    const previousEmail = env.DEMO_ACCOUNT_EMAIL;
    env.DEMO_ACCOUNT_EMAIL = DEMO_EMAIL;
    try {
      const demo = registeredToolNames(DEMO_EMAIL);
      expect(demo.filter((name) => standardWriteToolNames.has(name))).toEqual(
        [],
      );
      expect(demo).toContain("list_templates");
      expect(registeredToolNames("member@example.test")).toContain(
        "fill_template",
      );
    } finally {
      env.DEMO_ACCOUNT_EMAIL = previousEmail;
    }
  });
});
