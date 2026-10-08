import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { registerSandboxTestHygiene } from "@/api/handlers/chat/tools/execute/sandbox/sandbox-test-hygiene";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

import {
  buildChatCodeMode,
  chatScriptCallCatalog,
  chatScriptReadToolNames,
} from "./chat-code-mode";
import { CHAT_READ_SCRIPT_POLICY } from "./chat-read-script-policy";
import { classifyScriptName } from "./script-call-guide";

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
    documentedReads: [],
    memberRole: sessionMemberRole("owner"),
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
    userEmail: `user_${userCounter}@example.test`,
    scriptCallTools: () => ({
      directTools: ["execute_typescript", "discover_tools", "save_playbook"],
      unavailableReasons: new Map<string, string>(),
    }),
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
    // Doctored row: the declared `reference` string is null, so the
    // projection's strict parse fails the call as a server defect (same trip
    // wire as run-registry-tool.test.ts's fail-closed case).
    const rows = [
      {
        id: WS_UUID,
        name: "Acme",
        reference: null,
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
    const exceptions = analytics.exceptions().map((event) => event.properties);
    expect(exceptions).toMatchObject([
      {
        "error.class": "ChatToolError",
        source: "run-registry-tool",
        toolName: "list_matters",
      },
    ]);
    expect(JSON.stringify(exceptions)).toContain("matters[].reference");
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

describe("a chat script that calls something other than a script function", () => {
  const MATTER_ROWS = [
    {
      id: WS_UUID,
      name: "Acme",
      reference: "REF-1",
      status: "active",
      lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  ];

  const executeOf = (scopedDb: ScopedDb) => {
    const execute = buildChatCodeMode(buildProps(scopedDb)).tool.execute;
    return execute ?? expect.unreachable("execute_typescript has no execute");
  };

  test("is told to call a registry write as a direct tool, which never runs", async () => {
    let selects = 0;
    const execute = executeOf(
      selectScopedDb(MATTER_ROWS, () => {
        selects += 1;
      }),
    );

    const output = await execute({
      typescriptCode: `const { matters } = await external_list_matters({});
await save_playbook({ name: "NDA review", matter_id: matters[0].id });
return "saved";`,
    });

    expect(output).toMatchObject({
      success: false,
      error: {
        name: "not-a-script-function",
        message:
          "`save_playbook` is a direct tool, not a script function. Call it as its own tool call outside execute_typescript. Do the reads in the script, return the data, then call `save_playbook` with it.",
      },
    });
    // Only the read ran.
    expect(selects).toBe(1);
  });

  test("runs an unprefixed read through the registry read path, refs and all", async () => {
    const execute = executeOf(selectScopedDb(MATTER_ROWS));

    const output = await execute({
      typescriptCode: `const r = await list_matters({}); return r.matters;`,
    });

    expect(output).toMatchObject({
      success: true,
      logs: [
        "WARN: Ran `external_list_matters` for `list_matters`; use the external_ name in scripts.",
      ],
    });
    const serialized = JSON.stringify(output);
    expect(serialized).toContain("mat_1");
    expect(serialized).not.toContain(WS_UUID);
  });

  test("offers only registry reads as functions to run in place of a call", () => {
    const catalog = chatScriptCallCatalog({
      bindingNames: [
        "external_list_matters",
        "external_save_playbook",
        "external_delete_matter",
      ],
      turnTools: {
        directTools: ["save_playbook"],
        unavailableReasons: new Map(),
      },
    });

    expect(catalog.readFunctions).toEqual(["external_list_matters"]);
    for (const write of ["save_playbook", "savePlaybook", "delete_matter"]) {
      expect(classifyScriptName(write, catalog).kind).not.toBe("run-read");
    }
  });

  test("names a registry tool this chat does not offer as unavailable", () => {
    const catalog = chatScriptCallCatalog({
      bindingNames: ["external_list_matters"],
      turnTools: {
        directTools: [],
        unavailableReasons: new Map([
          ["counterparty_check", "anonymized mode is on"],
        ]),
      },
    });

    expect(classifyScriptName("delete_matter", catalog)).toMatchObject({
      kind: "unavailable",
      tool: "delete_matter",
    });
    expect(classifyScriptName("counterparty_check", catalog)).toMatchObject({
      kind: "unavailable",
      reason: "anonymized mode is on",
    });
  });
});

// A failed script's error text is document content: it reaches the model
// through the tool result and nowhere else. patches/@tanstack%2Fai-code-mode
// removes the dependency's console.error of it; these tests fail if a version
// bump restores that log or text reaches any other process sink.
describe("a failed chat script keeps its error text out of process logs", () => {
  const MARKER = "Synthetic Private Marker";

  const silenceProcessSinks = () => [
    spyOn(console, "error").mockImplementation(() => {}),
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(console, "info").mockImplementation(() => {}),
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "debug").mockImplementation(() => {}),
    spyOn(process.stdout, "write").mockImplementation(() => true),
    spyOn(process.stderr, "write").mockImplementation(() => true),
  ];

  let logger: RecordingLogger;
  let sinks: ReturnType<typeof silenceProcessSinks> = [];

  beforeEach(() => {
    logger = installRecordingLogger();
    sinks = silenceProcessSinks();
  });

  afterEach(() => {
    for (const sink of sinks) {
      sink.mockRestore();
    }
    logger.restore();
  });

  const expectMarkerOnlyInResult = (output: unknown) => {
    expect(output).toMatchObject({
      success: false,
      error: { name: "runtime", message: expect.stringContaining(MARKER) },
    });
    for (const sink of sinks) {
      expect(Bun.inspect(sink.mock.calls)).not.toContain(MARKER);
    }
    expect(Bun.inspect(logger.records)).not.toContain(MARKER);
    expect(Bun.inspect(analytics.events)).not.toContain(MARKER);
  };

  test("text the script threw itself", async () => {
    const execute =
      buildChatCodeMode(buildProps(selectScopedDb([]))).tool.execute ??
      expect.unreachable("execute_typescript has no execute");

    const output = await execute({
      typescriptCode: `throw new Error(${JSON.stringify(MARKER)});`,
    });

    expectMarkerOnlyInResult(output);
  });

  test("completion events omit error text while the tool result retains it", async () => {
    const execute =
      buildChatCodeMode(buildProps(selectScopedDb([]))).tool.execute ??
      expect.unreachable("execute_typescript has no execute");
    const events: { name: string; value: unknown }[] = [];

    const output = await execute(
      { typescriptCode: `throw new Error(${JSON.stringify(MARKER)});` },
      {
        emitCustomEvent: (name, value) => {
          events.push({ name, value });
        },
      },
    );

    expectMarkerOnlyInResult(output);
    const finished = events.filter(
      ({ name }) => name === "code_mode:execution_finished",
    );
    expect(finished).toHaveLength(1);
    const event = finished.at(0) ?? expect.unreachable("no completion event");
    expect(event.value).toMatchObject({
      success: false,
      phase: "execute",
      error: { name: "runtime" },
    });
    expect(event.value).not.toHaveProperty("error.message");
    expect(event.value).not.toHaveProperty("error.stack");
    expect(Bun.inspect(events)).not.toContain(MARKER);
  });

  test("text the script read from a tool and then threw", async () => {
    const rows = [
      {
        id: WS_UUID,
        name: MARKER,
        reference: "REF-1",
        status: "active",
        lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];
    const execute =
      buildChatCodeMode(buildProps(selectScopedDb(rows))).tool.execute ??
      expect.unreachable("execute_typescript has no execute");

    const output = await execute({
      typescriptCode: `const { matters } = await external_list_matters({});
throw new Error(matters[0].name);`,
    });

    expectMarkerOnlyInResult(output);
  });
});

describe("the chat read script policy", () => {
  const directOnly = Object.entries(CHAT_READ_SCRIPT_POLICY).flatMap(
    ([name, policy]) => (policy === "direct-only" ? [name] : []),
  );

  test("the script catalog follows each read's declared policy", () => {
    // Without a caller, enrolment-gated reads stay hidden.
    const scriptReads = Object.entries(CHAT_READ_SCRIPT_POLICY).flatMap(
      ([name, policy]) =>
        policy === "script" &&
        getStaticMcpToolDefinition(name)?.featureId === undefined
          ? [name]
          : [],
    );
    expect(directOnly).toEqual([
      "search_boe_legislation",
      "lookup_business_registry",
    ]);
    expect(new Set<string>(chatScriptReadToolNames())).toEqual(
      new Set(scriptReads),
    );
  });

  test("direct-only reads are neither advertised nor discoverable in a chat script", async () => {
    const codeMode = buildChatCodeMode(buildProps(selectScopedDb([])));
    const discover =
      codeMode.discoveryTool?.execute ??
      expect.unreachable("discover_tools has no execute");
    for (const name of directOnly) {
      expect(codeMode.systemPrompt).not.toContain(`external_${name}`);
      expect(
        JSON.stringify(await discover({ toolNames: [name] })),
      ).not.toContain("Returns:");
    }
  });

  test.each([
    ["search_boe_legislation", `{ title: "Synthetic Client Novák" }`],
    ["lookup_business_registry", `{ query: "Synthetic Client Novák" }`],
  ])(
    "a script calling the direct-only read %s fails before any request",
    async (name, args) => {
      const fetchSpy = spyOn(globalThis, "fetch");
      try {
        const execute =
          buildChatCodeMode(buildProps(selectScopedDb([]))).tool.execute ??
          expect.unreachable("execute_typescript has no execute");
        const output = await execute({
          typescriptCode: `return await external_${name}(${args});`,
        });
        expect(output).toMatchObject({ success: false });
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );
});
