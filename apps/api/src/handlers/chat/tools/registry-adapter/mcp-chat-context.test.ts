import { describe, expect, mock, test } from "bun:test";

import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import type { ChatRegistryContextDeps } from "./mcp-chat-context";
import { buildMcpContextFromChat } from "./mcp-chat-context";

const workspaceOne = toSafeId<"workspace">("ws_1");
const workspaceTwo = toSafeId<"workspace">("ws_2");

const buildDeps = (
  overrides: Partial<ChatRegistryContextDeps> = {},
): ChatRegistryContextDeps => {
  const { safeDb, scopedDb } = createScopedDbMock({});
  return {
    organizationId: toSafeId<"organization">("org_1"),
    userId: toSafeId<"user">("user_1"),
    memberRole: "owner",
    safeDb,
    scopedDb,
    toolWorkspaceIds: resolveToolWorkspaceIds({
      accessibleWorkspaceIds: [workspaceOne, workspaceTwo],
      pinnedIds: [],
    }),
    ...overrides,
  };
};

describe("buildMcpContextFromChat", () => {
  test("maps every McpRequestContext field from chat-resolved state", () => {
    const deps = buildDeps();
    const context = buildMcpContextFromChat(deps);

    expect(context.accessibleWorkspaceIds).toEqual([
      workspaceOne,
      workspaceTwo,
    ]);
    expect([...context.accessibleWorkspaceIdSet]).toEqual([
      workspaceOne,
      workspaceTwo,
    ]);
    // No status carried by chat's authorized ids, and read tools never consult
    // it: every authorized workspace defaults to "active".
    expect(context.accessibleWorkspaceStatusById).toEqual(
      new Map([
        [workspaceOne, "active"],
        [workspaceTwo, "active"],
      ]),
    );
    expect(context.memberRole).toBe(deps.memberRole);
    expect(context.organizationId).toBe(deps.organizationId);
    expect(context.userId).toBe(deps.userId);
    expect(context.safeDb).toBe(deps.safeDb);
    expect(context.scopedDb).toBe(deps.scopedDb);
  });

  test("copies the workspace id list instead of aliasing the input", () => {
    const deps = buildDeps();
    const context = buildMcpContextFromChat(deps);
    expect(context.accessibleWorkspaceIds).not.toBe(deps.toolWorkspaceIds);
  });

  test("threads a supplied audit recorder through, and no-ops when absent", async () => {
    const recorder = asTestRaw<AuditRecorder & ReturnType<typeof mock>>(
      mock(async () => undefined),
    );
    expect(
      buildMcpContextFromChat(buildDeps({ recordAuditEvent: recorder }))
        .recordAuditEvent,
    ).toBe(recorder);

    // Absent recorder resolves to a callable no-op, never undefined.
    const noop = buildMcpContextFromChat(
      buildDeps({ recordAuditEvent: undefined }),
    ).recordAuditEvent;
    expect(typeof noop).toBe("function");
    const settled = noop(asTestRaw(null), asTestRaw({ action: "noop" }));
    expect(settled).toBeInstanceOf(Promise);
    await settled;
  });

  test("uses a supplied per-workspace status override when the writer path needs it", () => {
    const context = buildMcpContextFromChat(
      buildDeps({
        workspaceStatusById: new Map([[workspaceTwo, "archived"]]),
      }),
    );
    expect(context.accessibleWorkspaceStatusById.get(workspaceOne)).toBe(
      "active",
    );
    expect(context.accessibleWorkspaceStatusById.get(workspaceTwo)).toBe(
      "archived",
    );
  });
});
