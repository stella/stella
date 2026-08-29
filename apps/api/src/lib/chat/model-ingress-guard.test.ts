import type { MCPToolSource, ServerTool } from "@tanstack/ai";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  assertModelSurfaceFreeOfTenantIds,
  guardMcpToolSource,
  guardModelMessages,
  guardModelSystemPrompt,
  guardModelToolSchemas,
  redactModelSystemPrompt,
  redactTenantIdsDeep,
  TENANT_ID_REDACTION_PLACEHOLDER,
} from "@/api/lib/chat/model-ingress-guard";
import type {
  GuardedModelMessages,
  GuardedSystemPrompt,
  GuardedToolSchemas,
} from "@/api/lib/chat/model-ingress-guard";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

const WS_A = toSafeId<"workspace">("0dc54d0c-10d7-501d-897e-e801dbd0998c");
const WS_B = toSafeId<"workspace">("4e919658-a448-5354-8e3a-e99911214d2c");
const PUBLIC_UUID = "7c0f7d51-70a4-4d64-9f0e-0a4d64e9911b";

let analytics: RecordingAnalytics;
let logs: RecordingLogger;

beforeEach(() => {
  analytics = installRecordingAnalytics();
  logs = installRecordingLogger();
});

afterEach(() => {
  analytics.restore();
  logs.restore();
});

describe("redactTenantIdsDeep", () => {
  test("replaces tenant ids in nested strings, preserves everything else", () => {
    const createdAt = new Date("2026-01-01");
    const { value, redactedPaths } = redactTenantIdsDeep({
      value: {
        parts: [
          {
            type: "text",
            content: `See https://my.stll.app/workspaces/${WS_A}/x`,
          },
          { type: "text", content: `public ${PUBLIC_UUID} stays` },
        ],
        createdAt,
        count: 2,
      },
      workspaceIds: [WS_A, WS_B],
    });

    expect(value.parts[0]?.content).toBe(
      `See https://my.stll.app/workspaces/${TENANT_ID_REDACTION_PLACEHOLDER}/x`,
    );
    // Non-tenant UUIDs (public corpus ids, version handles) are untouched:
    // the guard is membership-exact, not pattern-based.
    expect(value.parts[1]?.content).toBe(`public ${PUBLIC_UUID} stays`);
    // structuredClone copies the Date: same instant, fresh instance.
    expect(value.createdAt).toEqual(createdAt);
    expect(value.count).toBe(2);
    expect(redactedPaths).toEqual(["$.parts[0].content"]);
    // Routine traffic (a pasted app URL) is logged, never captured as an
    // exception; the log carries paths, never the id value.
    expect(analytics.exceptions()).toEqual([]);
    expect(logs.at("WARN")).toHaveLength(1);
    const attributes = logs.at("WARN").at(0)?.attributes;
    expect(JSON.stringify(attributes)).not.toContain(WS_A);
  });

  test("clean input passes through without telemetry", () => {
    const input = { parts: [{ type: "text", content: "all refs: mat_1" }] };
    const { value, redactedPaths } = redactTenantIdsDeep({
      value: input,
      workspaceIds: [WS_A],
    });
    expect(value).toEqual(input);
    expect(redactedPaths).toEqual([]);
    expect(analytics.exceptions()).toEqual([]);
    expect(logs.at("WARN")).toEqual([]);
  });
});

describe("assertModelSurfaceFreeOfTenantIds", () => {
  test("panics when the system prompt embeds a tenant id", () => {
    expect(() =>
      assertModelSurfaceFreeOfTenantIds({
        serialized: `Connected to matter ${WS_A}`,
        surface: "system-prompt",
        workspaceIds: [WS_A],
      }),
    ).toThrow("Model-bound system-prompt embeds a tenant workspace id");
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      {
        "error.class": "TelemetryError",
        source: "model-ingress-guard",
        surface: "system-prompt",
      },
    ]);
    // The redaction contract holds all the way to the sink: the id that
    // triggered the capture is never part of the shipped event.
    expect(JSON.stringify(analytics.exceptions())).not.toContain(WS_A);
  });

  test("captures but does not throw for tool schemas", () => {
    expect(() =>
      assertModelSurfaceFreeOfTenantIds({
        serialized: `{"description":"Allowed values: ${WS_A}"}`,
        surface: "tool-schemas",
        workspaceIds: [WS_A],
      }),
    ).not.toThrow();
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      {
        "error.class": "TelemetryError",
        source: "model-ingress-guard",
        surface: "tool-schemas",
      },
    ]);
  });

  test("clean surfaces pass silently", () => {
    assertModelSurfaceFreeOfTenantIds({
      serialized: "Allowed values: mat_1, mat_2",
      surface: "system-prompt",
      workspaceIds: [WS_A, WS_B],
    });
    expect(analytics.exceptions()).toEqual([]);
  });
});

// The brands are the seam `streamChat`'s provider dispatch accepts: only the
// entry points below mint them, so these tests pin that minting a brand and
// running the guard are the same act.
describe("guarded model surfaces", () => {
  const acceptsGuardedMessages = <TMessages extends readonly object[]>(
    value: GuardedModelMessages<TMessages>,
  ) => value;
  const acceptsGuardedSystemPrompt = (value: GuardedSystemPrompt) => value;
  const acceptsGuardedToolSchemas = <TTools extends readonly object[]>(
    value: GuardedToolSchemas<TTools>,
  ) => value;

  test("branding messages redacts tenant ids and reports the path", () => {
    const messages = [
      {
        id: "user-1",
        parts: [
          {
            content: `Check https://my.stll.app/workspaces/${WS_A}/matters`,
            type: "text",
          },
        ],
        role: "user",
      },
      {
        id: "assistant-1",
        parts: [{ content: `Public ${PUBLIC_UUID} stays`, type: "text" }],
        role: "assistant",
      },
    ];

    const guarded = guardModelMessages({
      messages,
      workspaceIds: [WS_A, WS_B],
    });

    expect(acceptsGuardedMessages(guarded)).toBe(guarded);
    expect(guarded[0]?.parts[0]?.content).toBe(
      `Check https://my.stll.app/workspaces/${TENANT_ID_REDACTION_PLACEHOLDER}/matters`,
    );
    expect(guarded[1]?.parts[0]?.content).toBe(`Public ${PUBLIC_UUID} stays`);
    // The caller's array is left untouched: the model gets the redacted copy.
    expect(messages[0]?.parts[0]?.content).toContain(WS_A);
    expect(analytics.exceptions()).toEqual([]);
    expect(logs.at("WARN")).toHaveLength(1);
    const attributes = logs.at("WARN").at(0)?.attributes;
    expect(JSON.stringify(attributes)).toContain("$[0].parts[0].content");
    expect(JSON.stringify(attributes)).not.toContain(WS_A);

    // @ts-expect-error unguarded messages must not reach the model dispatch
    acceptsGuardedMessages(messages);
  });

  test("branding tool schemas captures telemetry without killing the turn", () => {
    const tools = [
      {
        description: `Search matters. Known ids: ${WS_A}`,
        name: "external_search_across_matters",
      },
      { description: `Public ${PUBLIC_UUID}`, name: "search_case_law" },
    ];

    const guarded = guardModelToolSchemas({ tools, workspaceIds: [WS_A] });

    expect(acceptsGuardedToolSchemas(guarded)).toBe(guarded);
    // Tool schemas are passed through untouched; only the system prompt fails
    // closed and only messages are rewritten.
    const dispatchedTools: readonly object[] = guarded;
    expect(dispatchedTools).toBe(tools);
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      { "error.class": "TelemetryError", surface: "tool-schemas" },
    ]);
    expect(JSON.stringify(analytics.exceptions())).not.toContain(WS_A);

    // @ts-expect-error unguarded tool schemas must not reach the model dispatch
    acceptsGuardedToolSchemas(tools);
  });

  const mcpToolSource = (
    description: string,
  ): [MCPToolSource, () => number] => {
    let fetches = 0;
    const tool: ServerTool = {
      __toolSide: "server",
      description,
      name: "mcp__crm__search",
    };
    return [
      {
        close: async () => undefined,
        tools: async () => {
          fetches += 1;
          return [tool];
        },
      },
      () => fetches,
    ];
  };

  test("lazily fetched MCP schemas are guarded at fetch time", async () => {
    const [source, fetches] = mcpToolSource(`Search the CRM. Matter: ${WS_A}`);
    const guarded = guardMcpToolSource({ source, workspaceIds: [WS_A] });

    // Wrapping alone must not fetch, and must not report: the connector's
    // schemas do not exist yet when the source is assembled.
    expect(fetches()).toBe(0);
    expect(analytics.exceptions()).toEqual([]);

    const fetched = await guarded.tools({ lazy: true });

    expect(fetches()).toBe(1);
    expect(fetched.at(0)?.name).toBe("mcp__crm__search");
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      { "error.class": "TelemetryError", surface: "tool-schemas" },
    ]);
    expect(JSON.stringify(analytics.exceptions())).not.toContain(WS_A);
  });

  test("clean MCP schemas fetch without telemetry", async () => {
    const [source] = mcpToolSource("Search the CRM.");
    const guarded = guardMcpToolSource({ source, workspaceIds: [WS_A, WS_B] });

    expect((await guarded.tools({ lazy: true })).at(0)?.name).toBe(
      "mcp__crm__search",
    );
    expect(analytics.exceptions()).toEqual([]);
  });

  test("redact mode keeps a mixed-provenance system prompt alive", () => {
    const redacted = redactModelSystemPrompt({
      system: `Loop detected in tool mcp__crm__${WS_A}. Public: ${PUBLIC_UUID}`,
      workspaceIds: [WS_A, WS_B],
    });

    const dispatchedSystem: string = redacted;
    expect(dispatchedSystem).toBe(
      `Loop detected in tool mcp__crm__${TENANT_ID_REDACTION_PLACEHOLDER}. Public: ${PUBLIC_UUID}`,
    );
    expect(acceptsGuardedSystemPrompt(redacted)).toBe(redacted);
    expect(analytics.exceptions()).toEqual([]);
    expect(logs.at("WARN")).toHaveLength(1);
    const attributes = logs.at("WARN").at(0)?.attributes;
    expect(attributes).toEqual({
      pathCount: "1",
      paths: "$",
      surface: "system-prompt-mixed",
    });
    expect(JSON.stringify(attributes)).not.toContain(WS_A);
  });

  test("redact mode leaves a clean system prompt untouched and silent", () => {
    const system = "Loop detected in tool search_case_law.";
    const dispatchedSystem: string = redactModelSystemPrompt({
      system,
      workspaceIds: [WS_A],
    });
    expect(dispatchedSystem).toBe(system);
    expect(analytics.exceptions()).toEqual([]);
  });

  test("branding the system prompt fails closed on a tenant id", () => {
    expect(() =>
      guardModelSystemPrompt({
        system: `Connected matter: ${WS_A}`,
        workspaceIds: [WS_A],
      }),
    ).toThrow("Model-bound system-prompt embeds a tenant workspace id");
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      {
        "error.class": "TelemetryError",
        source: "model-ingress-guard",
        surface: "system-prompt",
      },
    ]);

    const clean = guardModelSystemPrompt({
      system: `Connected matter: mat_1 (public decision ${PUBLIC_UUID})`,
      workspaceIds: [WS_A, WS_B],
    });
    expect(acceptsGuardedSystemPrompt(clean)).toBe(clean);

    // @ts-expect-error an unguarded prompt string must not reach the dispatch
    acceptsGuardedSystemPrompt(`Connected matter: mat_1`);
  });
});
