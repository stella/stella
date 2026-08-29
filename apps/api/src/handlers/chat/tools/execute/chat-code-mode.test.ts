import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { registerSandboxTestHygiene } from "@/api/handlers/chat/tools/execute/sandbox/sandbox-test-hygiene";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

import { buildChatCodeMode } from "./chat-code-mode";

// Drives the real QuickJS sandbox through execute_typescript: share the sandbox
// suite's 15s ceiling and drain the process-global admission state after each
// test so a run here cannot bleed into a later sandbox test file.
registerSandboxTestHygiene();

// The real capture path runs; only the sink is in memory, and installing per
// test clears the repeat-suppression window.
let analytics: RecordingAnalytics;

beforeEach(() => {
  analytics = installRecordingAnalytics();
});

afterEach(() => {
  analytics.restore();
});

const WS_UUID = "0dc54d0c-10d7-501d-897e-e801dbd0998c";

const selectScopedDb = (
  rows: readonly unknown[],
  onSelect?: () => void,
): ScopedDb =>
  asTestRaw<ScopedDb>(async (run: (tx: unknown) => unknown) => {
    const builder = {
      select: () => {
        onSelect?.();
        return builder;
      },
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
    toolDefectMemo: createChatToolDefectMemo(),
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

  test("a converted tool's description carries its schema-derived Returns shape", async () => {
    const codeMode = buildChatCodeMode(buildProps(selectScopedDb([])));

    // Eager path: list_matters' Returns line lands in the system prompt stub.
    expect(codeMode.systemPrompt).toContain("Returns: {");

    // Lazy path: read_document's full description is served by discover_tools.
    const discover = codeMode.discoveryTool?.execute ?? undefined;
    if (discover === undefined) {
      throw new Error("discover_tools has no server execute");
    }
    const discovered = JSON.stringify(
      await discover({ toolNames: ["read_document"] }),
    );
    expect(discovered).toContain("Returns:");
    expect(discovered).toContain("entityId");
    expect(discovered).toContain("propertyId");
    expect(discovered).toContain("versions?");
    expect(discovered).toContain("diff");
    // Stripped file plumbing is not advertised to the model.
    expect(discovered).not.toContain("sha256Hex");

    // Every projectable read tool carries a schema now, so the Returns line
    // applies across the catalog, not only to the first-wave conversions;
    // list_documents stands in for the rest.
    const discoveredDocuments = JSON.stringify(
      await discover({ toolNames: ["list_documents"] }),
    );
    expect(discoveredDocuments).toContain("Returns:");
    expect(discoveredDocuments).toContain("documents");
    expect(discoveredDocuments).toContain("parentId");
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

  test("refuses to re-execute a call that already failed with a server defect", async () => {
    // Doctored row: `reference` holds a raw UUID the ref map never mediates,
    // so the projection's UUID backstop fails the call as a server defect
    // (same trip wire as run-registry-tool.test.ts's fail-closed case).
    const rows = [
      {
        id: WS_UUID,
        name: "Acme",
        reference: "4e919658-a448-5354-8e3a-e99911214d2c",
        status: "active",
        lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];
    let selectCalls = 0;
    const codeMode = buildChatCodeMode(
      buildProps(
        selectScopedDb(rows, () => {
          selectCalls += 1;
        }),
      ),
    );
    const execute = codeMode.tool.execute ?? undefined;
    if (execute === undefined) {
      throw new Error("execute_typescript tool has no server execute");
    }
    const script = `return await external_list_matters({});`;

    const first = await execute({ typescriptCode: script });
    expect(first).toMatchObject({ success: false });
    const callsAfterFirst = selectCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // The identical call is refused before dispatch: no new DB work, and the
    // refusal names the mechanism instead of re-running the defective tool.
    const second = await execute({ typescriptCode: script });
    expect(second).toMatchObject({ success: false });
    expect(selectCalls).toBe(callsAfterFirst);
    expect(JSON.stringify(second)).toContain("refused without re-executing");

    // The defect is reported once, by the run that actually executed; the
    // memoized refusal reports nothing new.
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      {
        "error.class": "ChatToolError",
        path: "matters[].reference",
        source: "run-registry-tool",
        toolName: "list_matters",
      },
    ]);
  });

  test("does not memoize non-defect failures: a corrected call still runs", async () => {
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

    // invalid-input failure (unknown ref) must not trip the defect memo...
    const bad = await execute({
      typescriptCode: `return await external_list_matters({ matter_id: "mat_999" });`,
    });
    expect(bad).toMatchObject({ success: false });

    // ...so the corrected call executes normally.
    const good = await execute({
      typescriptCode: `return await external_list_matters({});`,
    });
    expect(good).toMatchObject({ success: true });
  });
});
