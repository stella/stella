import { describe, expect, mock, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { registerSandboxTestHygiene } from "@/api/handlers/chat/tools/execute/sandbox/sandbox-test-hygiene";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

// Drives the real QuickJS sandbox through execute_typescript: share the sandbox
// suite's 15s ceiling and drain the process-global admission state after each
// test so a run here cannot bleed into a later sandbox test file.
registerSandboxTestHygiene();

const captureErrorMock = mock();
void mock.module("@/api/lib/analytics/capture", () => ({
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
  getAnalytics: mock(() => ({ capture: mock(), flush: mock() })),
}));

const { buildChatCodeMode } = await import("./chat-code-mode");

const WS_UUID = "0dc54d0c-10d7-501d-897e-e801dbd0998c";

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

let userCounter = 0;

const buildProps = (scopedDb: ScopedDb) => {
  userCounter += 1;
  return {
    memberRole: "owner" as const,
    organizationId: toSafeId<"organization">("org_1"),
    refRegistry: createChatRefRegistry(),
    safeDb: toSafeDbMock(scopedDb),
    scopedDb,
    toolWorkspaceIds: resolveToolWorkspaceIds({
      accessibleWorkspaceIds: [toSafeId<"workspace">(WS_UUID)],
      pinnedIds: [],
    }),
    userId: toSafeId<"user">(`user_${userCounter}`),
  };
};

describe("buildChatCodeMode", () => {
  test("emits an execute_typescript tool, a discover_tools companion, and a system prompt", () => {
    const codeMode = buildChatCodeMode(buildProps(selectScopedDb([])));

    expect(codeMode.tool.name).toBe("execute_typescript");
    // Lazy billing/research-admin/case-law tools force a discovery companion.
    expect(codeMode.discoveryTool).not.toBeNull();
    expect(codeMode.tools.length).toBe(2);

    // Eager reads get a full type stub in the system prompt.
    expect(codeMode.systemPrompt).toContain(
      "declare function external_list_matters",
    );
    // Lazy reads are held out of the eager stub catalog (reachable only via
    // discover_tools), so they carry no `declare function` signature.
    expect(codeMode.systemPrompt).not.toContain(
      "declare function external_list_invoices",
    );
    // But lazy reads are still advertised by name in the discovery catalog.
    expect(codeMode.systemPrompt).toContain("external_search_case_law");
  });

  test("runs a projected read tool end-to-end through the sandbox with refs, no raw UUIDs", async () => {
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
    const codeMode = buildChatCodeMode(buildProps(selectScopedDb(rows)));

    const execute = codeMode.tool.execute ?? undefined;
    if (execute === undefined) {
      throw new Error("execute_typescript tool has no server execute");
    }
    const output = await execute({
      typescriptCode: `const r = await external_list_matters({}); return r.matters;`,
    });

    expect(output).toMatchObject({ success: true });
    const serialized = JSON.stringify(output);
    // The matter's workspace UUID is a chat ref in the sandbox result, and no
    // raw UUID reaches the model-facing payload.
    expect(serialized).toContain("mat_1");
    expect(serialized).not.toContain(WS_UUID);
  });

  test("surfaces a projected tool's ChatToolError as an execution failure", async () => {
    const codeMode = buildChatCodeMode(buildProps(selectScopedDb([])));
    const execute = codeMode.tool.execute ?? undefined;
    if (execute === undefined) {
      throw new Error("execute_typescript tool has no server execute");
    }

    // A matter ref to a workspace outside the accessible set is rejected by the
    // handler; the rejection propagates out of the sandbox as a failed run.
    const output = await execute({
      typescriptCode: `return await external_list_matters({ matter_id: "mat_999" });`,
    });

    expect(output).toMatchObject({ success: false });
  });
});
