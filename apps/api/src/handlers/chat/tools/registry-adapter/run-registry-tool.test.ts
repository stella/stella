import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const captureErrorMock = mock();
void mock.module("@/api/lib/analytics/capture", () => ({
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
  getAnalytics: mock(() => ({ capture: mock(), flush: mock() })),
}));

const { buildMcpContextFromChat } = await import("./mcp-chat-context");
const { containsRawUuid, dehydrateInputRefs } = await import("./ref-mediation");
const { runRegistryReadTool } = await import("./run-registry-tool");

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
  beforeEach(() => {
    captureErrorMock.mockClear();
  });

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

  test("fails closed when a raw uuid survives ref hydration at an undeclared path", async () => {
    const registry = createChatRefRegistry();
    // Doctored: `reference` is an ordinary free-text field the ref map never
    // mediates (it is not one of `list_matters`'s `outputRefs` or
    // `passthroughIdPaths`), but nothing stops it from holding a raw uuid.
    // The path-aware backstop must catch this survivor at its exact path even
    // though no per-field ref rule exists for it.
    const rows = [
      {
        id: WS_UUID,
        name: "Acme",
        reference: OTHER_WS_UUID,
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

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).not.toContain(WS_UUID);
      expect(result.error.message).not.toContain(OTHER_WS_UUID);
    }
    // Telemetry carries the offending path so the survivor is traceable, but
    // never the leaked value itself.
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.any(String) }),
      {
        source: "run-registry-tool",
        toolName: "list_matters",
        path: "matters[].reference",
      },
    );
    const [, telemetryContext] = captureErrorMock.mock.calls.at(0) ?? [];
    expect(JSON.stringify(telemetryContext)).not.toContain(OTHER_WS_UUID);
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
