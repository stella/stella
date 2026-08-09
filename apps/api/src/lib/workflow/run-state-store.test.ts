import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  createWorkflowRunStateStore,
  parseWorkflowFinalizationManifest,
  requireWorkflowFinalizationManifest,
} from "@/api/lib/workflow/run-state-store";

const requestId = "019c3f44-a5a2-7000-8000-000000000001";
const propertyId = toSafeId<"property">("019c3f44-a5a2-7000-8000-000000000002");
const workspaceId = toSafeId<"workspace">(
  "019c3f44-a5a2-7000-8000-000000000003",
);

const validManifest = {
  version: 1,
  requestId,
  freshnessScope: "workspace",
  propertyIds: [propertyId],
  serviceTier: "standard",
} as const;

describe("workflow finalization manifest", () => {
  test("round-trips a complete, request-bound manifest", () => {
    expect(
      parseWorkflowFinalizationManifest({
        expectedRequestId: requestId,
        raw: JSON.stringify(validManifest),
      }),
    ).toEqual({
      status: "available",
      manifest: validManifest,
    });
  });

  test("distinguishes missing state from corrupt state", () => {
    expect(
      parseWorkflowFinalizationManifest({
        expectedRequestId: requestId,
        raw: null,
      }),
    ).toEqual({ status: "missing" });
    expect(
      parseWorkflowFinalizationManifest({
        expectedRequestId: requestId,
        raw: "{",
      }),
    ).toEqual({ status: "corrupt", reason: "invalid-json" });
  });

  test("rejects every incomplete or ambiguous manifest shape", () => {
    const invalid = [
      { ...validManifest, version: 2 },
      { ...validManifest, propertyIds: [] },
      { ...validManifest, propertyIds: [propertyId, 42] },
      { ...validManifest, propertyIds: [propertyId, propertyId] },
      { ...validManifest, freshnessScope: "unknown" },
      { ...validManifest, serviceTier: "unknown" },
      { ...validManifest, unexpected: true },
    ];
    const expectedReasons = [
      "invalid-shape",
      "invalid-shape",
      "invalid-shape",
      "duplicate-property-id",
      "invalid-shape",
      "invalid-shape",
      "invalid-shape",
    ] as const;
    expect(
      invalid.map((manifest) =>
        parseWorkflowFinalizationManifest({
          expectedRequestId: requestId,
          raw: JSON.stringify(manifest),
        }),
      ),
    ).toEqual(expectedReasons.map((reason) => ({ status: "corrupt", reason })));
  });

  test("rejects a valid manifest owned by another request", () => {
    expect(
      parseWorkflowFinalizationManifest({
        expectedRequestId: "019c3f44-a5a2-7000-8000-000000000004",
        raw: JSON.stringify(validManifest),
      }),
    ).toEqual({ status: "corrupt", reason: "request-mismatch" });
  });

  test("never yields a freshness plan for missing or corrupt state", () => {
    for (const state of [
      { status: "missing" },
      { status: "corrupt", reason: "invalid-json" },
    ] as const) {
      const result = requireWorkflowFinalizationManifest({
        state,
        workspaceId,
      });
      expect(Result.isError(result)).toBe(true);
    }
  });
});

describe("workflow finalization state reads", () => {
  test("initializes one versioned manifest and the completion total", async () => {
    const commands: { command: string; args: string[] }[] = [];
    const store = createWorkflowRunStateStore({
      send: async (command, args) => {
        commands.push({ command, args });
        return command === "SET" ? "OK" : 1;
      },
    });

    await store.initializeCompletion({
      manifest: validManifest,
      runLockTtlSec: 600,
      targetCount: 3,
      workspaceId,
    });

    expect(commands).toEqual([
      {
        command: "DEL",
        args: [`workflow:${workspaceId}:completed-entities`],
      },
      {
        command: "SET",
        args: [`workflow:${workspaceId}:total`, "3", "EX", "600"],
      },
      {
        command: "SET",
        args: [
          `workflow:${workspaceId}:finalization-v1`,
          JSON.stringify(validManifest),
          "EX",
          "600",
        ],
      },
    ]);
  });

  test("keeps Redis unavailability distinct from stored corruption", async () => {
    const redisFailure = new Error("redis unavailable");
    const store = createWorkflowRunStateStore({
      send: async () => {
        throw redisFailure;
      },
    });

    const result = await store.readFinalizationState({
      requestId,
      workspaceId,
    });

    expect(Result.isError(result)).toBe(true);
    if (!Result.isError(result)) {
      throw new TypeError("Expected unavailable workflow state");
    }
    expect(result.error.cause).toBe(redisFailure);
  });

  test("returns stored missing and corrupt states without throwing", async () => {
    await Promise.all(
      (
        [
          [null, { status: "missing" }],
          ["not-json", { status: "corrupt", reason: "invalid-json" }],
        ] as const
      ).map(async ([raw, expected]) => {
        const store = createWorkflowRunStateStore({
          send: async () => raw,
        });
        const result = await store.readFinalizationState({
          requestId,
          workspaceId,
        });
        expect(Result.isError(result)).toBe(false);
        if (!Result.isError(result)) {
          expect(result.value).toEqual(expected);
        }
      }),
    );
  });
});
