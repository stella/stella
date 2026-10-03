import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
} from "@/api/db/scoped";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { buildMcpContextFromChat } from "@/api/handlers/chat/tools/registry-adapter/mcp-chat-context";
import { runRegistryWriteTool } from "@/api/handlers/chat/tools/registry-adapter/run-registry-write-tool";
import type { SafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import {
  authorizedMemberRole,
  SESSION_CREDENTIAL,
} from "@/api/lib/permission-authorization";
import { loadAccessibleMcpWorkspaces } from "@/api/mcp/context";
import type { McpRequestContext } from "@/api/mcp/context";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { filterUsableMcpWorkspaces } from "@/api/mcp/workspace-session-scope";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

type Caller = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/** A brand-new organization: one owner, no matter at all. */
const createEmptyOrganization = async (): Promise<Caller> => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  await testDb
    .insert(user)
    .values({ id: userId, name: "Owner", email: `${userId}@test.local` });
  await testDb.insert(organization).values({
    id: organizationId,
    name: "New firm",
    slug: `new-firm-${organizationId}`,
    createdAt: new Date(),
  });
  await testDb.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  return { organizationId, userId };
};

/** What one MCP request resolves: the matters the caller can reach now. */
const mcpRequestContext = async ({
  organizationId,
  userId,
}: Caller): Promise<McpRequestContext> => {
  const identity = { organizationId, serverValidatedWorkspaceIds: [], userId };
  const scopedDb = asTestRaw<ScopedDb>(
    createMembershipScopedDb(testDb, identity),
  );
  const safeDb = asTestRaw<SafeDb>(createMembershipSafeDb(testDb, identity));
  const usable = filterUsableMcpWorkspaces({
    accessibleWorkspaces: await loadAccessibleMcpWorkspaces({
      organizationId,
      scopedDb,
    }),
    tokenWorkspaceIds: undefined,
  });
  const workspaceIds = usable.map((workspace) => workspace.id);
  return asTestRaw<McpRequestContext>({
    accessibleWorkspaceIds: workspaceIds,
    accessibleWorkspaceIdSet: new Set(workspaceIds),
    accessibleWorkspaceStatusById: new Map(
      usable.map((workspace) => [workspace.id, workspace.status]),
    ),
    accessibleWorkspaces: usable,
    // An OAuth session that may create matters and tasks.
    grantedScopes: ["stella:matters_write"],
    memberRole: "owner",
    organizationId,
    recordAuditEvent: async () => undefined,
    safeDb,
    scopedDb,
    userId,
    userEmail: "standard@example.test",
  });
};

const payloadOf = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
): unknown => {
  const item = result.content[0];
  if (item?.type !== "text") {
    throw new Error("Expected a text MCP response");
  }
  return JSON.parse(item.text);
};

describe("a write that needs a matter in an organization without one", () => {
  test("answers over MCP with the offer to create a matter", async () => {
    const context = await mcpRequestContext(await createEmptyOrganization());
    expect(context.accessibleWorkspaceIds).toEqual([]);
    const result = await handleMcpToolCall({
      args: { name: "Draft the NDA" },
      context,
      toolName: "save_task",
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({
      error: {
        code: "not_found",
        hint: expect.stringContaining("save_matter"),
        retryable: false,
      },
    });
  });

  test("does not name save_matter to a session without its scope", async () => {
    const context = await mcpRequestContext(await createEmptyOrganization());
    const result = await handleMcpToolCall({
      args: {
        source: {
          type: "previous",
          document_id: "0dc54d0c-10d7-401d-897e-e801dbd0998c",
          target_version_id: "4e919658-a448-4354-8e3a-e99911214d2c",
        },
        base_tracked_changes: "keep",
        target_tracked_changes: "keep",
        output_mode: "preview",
      },
      context: { ...context, grantedScopes: ["stella:documents_write"] },
      toolName: "compare_documents",
    });
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload).toMatchObject({ error: { code: "not_found" } });
    expect(JSON.stringify(payload)).not.toContain("save_matter");
  });

  test("answers in chat with the same offer", async () => {
    const caller = await createEmptyOrganization();
    const context = await mcpRequestContext(caller);
    const result = await runRegistryWriteTool({
      args: { name: "Draft the NDA" },
      context: buildMcpContextFromChat({
        memberRole: authorizedMemberRole({
          role: "owner",
          credential: SESSION_CREDENTIAL,
        }),
        organizationId: caller.organizationId,
        pinServerValidatedWorkspaceId: () => true,
        safeDb: context.safeDb,
        scopedDb: context.scopedDb,
        toolWorkspaceIds: resolveToolWorkspaceIds({
          accessibleWorkspaceIds: context.accessibleWorkspaceIds,
          pinnedIds: [],
        }),
        userId: caller.userId,
        userEmail: "standard@example.test",
      }),
      refRegistry: createChatRefRegistry(),
      toolName: "save_task",
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(ChatToolError);
      expect(result.error.kind).toBe("not-found");
      expect(result.error.message).toContain("save_matter");
    }
  });

  test("creates the first matter, then runs the retried write in it", async () => {
    const caller = await createEmptyOrganization();
    const created = await handleMcpToolCall({
      args: { name: "Acme acquisition" },
      context: await mcpRequestContext(caller),
      toolName: "save_matter",
    });
    expect(created.isError).toBeUndefined();
    const payload = payloadOf(created);
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("matterId" in payload) ||
      typeof payload.matterId !== "string"
    ) {
      throw new Error("save_matter returned no matter id");
    }
    const matterId = asTestRaw<SafeId<"workspace">>(payload.matterId);

    // The retry is a later request, as an approved chat call or the next MCP
    // call is, so it resolves the matters the caller can reach afresh.
    const context = await mcpRequestContext(caller);
    expect(context.accessibleWorkspaceIds).toEqual([matterId]);
    const retried = await handleMcpToolCall({
      args: { matter_id: matterId, name: "Draft the NDA" },
      context,
      toolName: "save_task",
    });
    expect(retried.isError).toBeUndefined();
  });
});
