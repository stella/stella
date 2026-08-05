import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type {
  GuardedModelMessages,
  GuardedSystemPrompt,
  GuardedToolSchemas,
} from "@/api/lib/chat/model-ingress-guard";

const captureErrorMock = mock();
void mock.module("@/api/lib/analytics/capture", () => ({
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
  getAnalytics: mock(() => ({ capture: mock(), flush: mock() })),
}));

const {
  assertModelSurfaceFreeOfTenantIds,
  guardModelMessages,
  guardModelSystemPrompt,
  guardModelToolSchemas,
  redactTenantIdsDeep,
  TENANT_ID_REDACTION_PLACEHOLDER,
} = await import("./model-ingress-guard");

const WS_A = toSafeId<"workspace">("0dc54d0c-10d7-501d-897e-e801dbd0998c");
const WS_B = toSafeId<"workspace">("4e919658-a448-5354-8e3a-e99911214d2c");
const PUBLIC_UUID = "7c0f7d51-70a4-4d64-9f0e-0a4d64e9911b";

describe("redactTenantIdsDeep", () => {
  test("replaces tenant ids in nested strings, preserves everything else", () => {
    captureErrorMock.mockClear();
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
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    // Telemetry carries paths, never the id value.
    const [, context] = captureErrorMock.mock.calls.at(0) ?? [];
    expect(JSON.stringify(context)).not.toContain(WS_A);
  });

  test("clean input passes through without telemetry", () => {
    captureErrorMock.mockClear();
    const input = { parts: [{ type: "text", content: "all refs: mat_1" }] };
    const { value, redactedPaths } = redactTenantIdsDeep({
      value: input,
      workspaceIds: [WS_A],
    });
    expect(value).toEqual(input);
    expect(redactedPaths).toEqual([]);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });
});

describe("assertModelSurfaceFreeOfTenantIds", () => {
  test("panics when the system prompt embeds a tenant id", () => {
    captureErrorMock.mockClear();
    expect(() =>
      assertModelSurfaceFreeOfTenantIds({
        serialized: `Connected to matter ${WS_A}`,
        surface: "system-prompt",
        workspaceIds: [WS_A],
      }),
    ).toThrow();
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });

  test("captures but does not throw for tool schemas", () => {
    captureErrorMock.mockClear();
    expect(() =>
      assertModelSurfaceFreeOfTenantIds({
        serialized: `{"description":"Allowed values: ${WS_A}"}`,
        surface: "tool-schemas",
        workspaceIds: [WS_A],
      }),
    ).not.toThrow();
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });

  test("clean surfaces pass silently", () => {
    captureErrorMock.mockClear();
    assertModelSurfaceFreeOfTenantIds({
      serialized: "Allowed values: mat_1, mat_2",
      surface: "system-prompt",
      workspaceIds: [WS_A, WS_B],
    });
    expect(captureErrorMock).not.toHaveBeenCalled();
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
    captureErrorMock.mockClear();
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
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    const [, context] = captureErrorMock.mock.calls.at(0) ?? [];
    expect(JSON.stringify(context)).toContain("$[0].parts[0].content");
    expect(JSON.stringify(context)).not.toContain(WS_A);

    // @ts-expect-error unguarded messages must not reach the model dispatch
    acceptsGuardedMessages(messages);
  });

  test("branding tool schemas captures telemetry without killing the turn", () => {
    captureErrorMock.mockClear();
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
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    const [, context] = captureErrorMock.mock.calls.at(0) ?? [];
    expect(JSON.stringify(context)).toContain("tool-schemas");
    expect(JSON.stringify(context)).not.toContain(WS_A);

    // @ts-expect-error unguarded tool schemas must not reach the model dispatch
    acceptsGuardedToolSchemas(tools);
  });

  test("branding the system prompt fails closed on a tenant id", () => {
    captureErrorMock.mockClear();
    expect(() =>
      guardModelSystemPrompt({
        system: `Connected matter: ${WS_A}`,
        workspaceIds: [WS_A],
      }),
    ).toThrow();
    expect(captureErrorMock).toHaveBeenCalledTimes(1);

    const clean = guardModelSystemPrompt({
      system: `Connected matter: mat_1 (public decision ${PUBLIC_UUID})`,
      workspaceIds: [WS_A, WS_B],
    });
    expect(acceptsGuardedSystemPrompt(clean)).toBe(clean);

    // @ts-expect-error an unguarded prompt string must not reach the dispatch
    acceptsGuardedSystemPrompt(`Connected matter: mat_1`);
  });
});
