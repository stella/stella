import { describe, expect, test } from "bun:test";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { getChatTools } from "@/api/handlers/chat/tools/chat-tools";
import { PAST_CHAT_SCOPE_TYPE } from "@/api/handlers/chat/tools/past-chat-tools";
import { WRITE_TOOL_REF_FIELD_MAP } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  WRITE_TOOL_SCOPE,
  WRITE_TOOL_SCOPES,
} from "@/api/mcp/matter-requirement";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";

const organizationId = toSafeId<"organization">(
  "11111111-1111-4111-8111-111111111111",
);
const userId = toSafeId<"user">("22222222-2222-4222-8222-222222222222");
const workspaceId = toSafeId<"workspace">(
  "33333333-3333-4333-8333-333333333333",
);
const threadId = toSafeId<"chatThread">("55555555-5555-4555-8555-555555555555");

const unusedScopedDb: ScopedDb = async () => {
  throw new Error("This test never reaches the database.");
};
const unusedSafeDb: SafeDb = async () => {
  throw new Error("This test never reaches the database.");
};
const noopAuditRecorder: AuditRecorder = async () => undefined;

const chatToolsFor = (accessibleWorkspaceIds: SafeId<"workspace">[]) =>
  getChatTools({
    featureAccessSnapshot: enrolledTimeBillingSnapshot({
      organizationId,
      userId,
    }),
    docxSuggestionSurface: "file-overlay",
    hasActiveDocxEditClient: false,
    hasActiveDocxFileClient: false,
    memberRole: sessionMemberRole("owner"),
    organizationId,
    orgAIConfig: null,
    managedAIResidency: "eu" as const,
    pastChatScope: { type: PAST_CHAT_SCOPE_TYPE.allChats },
    pinServerValidatedWorkspaceId: () => true,
    recordAuditEvent: noopAuditRecorder,
    refRegistry: createChatRefRegistry(),
    registryDispatch: BUSINESS_REGISTRY_DISPATCH,
    requestWorkspaceId: null,
    resolveCurrentMembership: async () => ({ role: "owner" }),
    safeDb: unusedSafeDb,
    scopedDb: unusedScopedDb,
    thirdPartyBoundary: { type: "raw" },
    threadId,
    toolDefectMemo: createChatToolDefectMemo(),
    toolWorkspaceIds: resolveToolWorkspaceIds({
      accessibleWorkspaceIds,
      pinnedIds: [],
    }),
    userId,
    userEmail: "standard@example.test",
    webSearchEnabled: false,
    webSearchProviders: { webSearchProvider: null, urlFetcher: null },
    workspaceId: null,
    workspaceStatusById: new Map(
      accessibleWorkspaceIds.map((id) => [id, "active"]),
    ),
  });

const projectedWriteToolNames = Object.entries(WRITE_TOOL_REF_FIELD_MAP)
  .filter(([, entry]) => entry.chatProjectable)
  .map(([name]) => name);

describe("chat write tools and the caller's matter count", () => {
  test("offers the same write tools with or without a matter", () => {
    // Both scopes must be in the projected set, or the comparison covers
    // only one of them.
    expect(projectedWriteToolNames).toContain("save_playbook");
    expect(projectedWriteToolNames).toContain("save_task");
    const withoutMatter = Object.keys(chatToolsFor([]));
    const withMatter = Object.keys(chatToolsFor([workspaceId]));
    for (const name of projectedWriteToolNames) {
      expect(withoutMatter, name).toContain(name);
    }
    expect(
      withoutMatter.filter((name) => projectedWriteToolNames.includes(name)),
    ).toEqual(
      withMatter.filter((name) => projectedWriteToolNames.includes(name)),
    );
  });

  test("answers a matter-scoped write with no matter by offering to create one", async () => {
    expect(WRITE_TOOL_SCOPES.save_task).toBe(WRITE_TOOL_SCOPE.matter);
    const saveTask = chatToolsFor([])["save_task"];
    if (saveTask?.execute === undefined) {
      throw new Error("save_task must be executable in an empty organization");
    }
    const failure = await Promise.resolve(
      saveTask.execute({ name: "Draft the NDA" }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ChatToolError);
    if (failure instanceof ChatToolError) {
      expect(failure.kind).toBe("not-found");
      expect(JSON.parse(failure.message)).toMatchObject({
        error: {
          code: "not_found",
          hint: expect.stringContaining("save_matter"),
        },
      });
    }
  });
});
