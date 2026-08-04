import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

const captureErrorMock = mock();
void mock.module("@/api/lib/analytics/capture", () => ({
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
  getAnalytics: mock(() => ({ capture: mock(), flush: mock() })),
}));

const {
  assertModelSurfaceFreeOfTenantIds,
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
