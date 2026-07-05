import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

import { buildMcpContextFromChat } from "./mcp-chat-context";
import { containsRawUuid, dehydrateInputRefs } from "./ref-mediation";
import { runRegistryReadTool } from "./run-registry-tool";

const WS_UUID = "0dc54d0c-10d7-501d-897e-e801dbd0998c";
const OTHER_WS_UUID = "4e919658-a448-5354-8e3a-e99911214d2c";

/** A scopedDb whose select chain resolves to the seeded matter rows. */
const selectScopedDb = (rows: readonly unknown[]): ScopedDb =>
  asTestRaw<ScopedDb>(async (run: (tx: unknown) => unknown) => {
    const builder = {
      select: () => builder,
      from: () => builder,
      where: () => builder,
      orderBy: () => builder,
      limit: async () => rows,
    };
    return await run(builder);
  });

const buildContext = ({
  accessibleWorkspaceIds = [toSafeId<"workspace">(WS_UUID)],
  scopedDb = selectScopedDb([]),
}: {
  accessibleWorkspaceIds?: ReturnType<typeof toSafeId<"workspace">>[];
  scopedDb?: ScopedDb;
} = {}): McpRequestContext =>
  buildMcpContextFromChat({
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    safeDb: toSafeDbMock(scopedDb),
    scopedDb,
    toolWorkspaceIds: resolveToolWorkspaceIds({
      accessibleWorkspaceIds,
      pinnedIds: [],
    }),
    userId: toSafeId<"user">("user_1"),
  });

describe("runRegistryReadTool", () => {
  test("runs list_matters end-to-end: output UUIDs become refs, input ref dehydrates", async () => {
    const registry = createChatRefRegistry();
    const rows = [
      {
        id: WS_UUID,
        name: "Acme",
        reference: "REF-1",
        status: "active",
        lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];

    const result = await runRegistryReadTool({
      args: {},
      context: buildContext({ scopedDb: selectScopedDb(rows) }),
      refRegistry: registry,
      toolName: "list_matters",
    });

    expect(Result.isError(result)).toBe(false);
    const payload = result.unwrap();
    // The matter's workspace UUID is replaced by its chat ref in the output.
    expect(payload).toMatchObject({
      matters: [{ id: "mat_1", name: "Acme", reference: "REF-1" }],
    });
    // The whole model-facing payload is free of raw UUIDs.
    expect(containsRawUuid(payload)).toBe(false);

    // A ref arg dehydrates back to its UUID before the handler sees it. The
    // registry already minted mat_1 while hydrating the output above.
    const dehydrated = dehydrateInputRefs({
      args: { matter_id: "mat_1" },
      refRegistry: registry,
      toolName: "list_matters",
    }).unwrap();
    expect(dehydrated.args["matter_id"]).toBe(WS_UUID);
  });

  test("maps an isError registry result to a ChatToolError", async () => {
    const registry = createChatRefRegistry();
    // A ref to a workspace that is NOT in the accessible set: detail mode
    // rejects it as not-found/not-accessible before touching the DB.
    const matterRef = registry.toMatterRef(
      toSafeId<"workspace">(OTHER_WS_UUID),
    );

    const result = await runRegistryReadTool({
      args: { matter_id: matterRef },
      context: buildContext(),
      refRegistry: registry,
      toolName: "list_matters",
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toContain("not accessible");
    }
  });

  test("refuses a read tool the ref map keeps off the chat surface", async () => {
    const result = await runRegistryReadTool({
      args: {},
      context: buildContext(),
      refRegistry: createChatRefRegistry(),
      toolName: "list_audit_log",
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toContain("not available in chat");
    }
  });
});
