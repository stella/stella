import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  createWorkflowRunStateStore,
  parseTransitionalWorkflowFinalizationManifest,
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

describe("transitional workflow finalization manifest", () => {
  test("strictly converts the immediately previous release state", () => {
    expect(
      parseTransitionalWorkflowFinalizationManifest({
        expectedRequestId: requestId,
        planPropertyIdsRaw: JSON.stringify([propertyId]),
        scopedRaw: null,
        serviceTierRaw: "flex",
      }),
    ).toEqual({
      status: "available",
      manifest: {
        ...validManifest,
        serviceTier: "flex",
      },
    });
    expect(
      parseTransitionalWorkflowFinalizationManifest({
        expectedRequestId: requestId,
        planPropertyIdsRaw: JSON.stringify([propertyId]),
        scopedRaw: "1",
        serviceTierRaw: "standard",
      }),
    ).toEqual({
      status: "available",
      manifest: {
        ...validManifest,
        freshnessScope: "cells",
      },
    });
  });

  test("treats only a fully absent previous-release snapshot as missing", () => {
    expect(
      parseTransitionalWorkflowFinalizationManifest({
        expectedRequestId: requestId,
        planPropertyIdsRaw: null,
        scopedRaw: null,
        serviceTierRaw: null,
      }),
    ).toEqual({ status: "missing" });
    expect(
      parseTransitionalWorkflowFinalizationManifest({
        expectedRequestId: requestId,
        planPropertyIdsRaw: JSON.stringify([propertyId]),
        scopedRaw: null,
        serviceTierRaw: null,
      }),
    ).toEqual({ status: "corrupt", reason: "invalid-shape" });
  });

  test("rejects malformed or ambiguous previous-release values", () => {
    const invalid = [
      { planPropertyIdsRaw: "{", scopedRaw: null, serviceTierRaw: "standard" },
      {
        planPropertyIdsRaw: JSON.stringify([]),
        scopedRaw: null,
        serviceTierRaw: "standard",
      },
      {
        planPropertyIdsRaw: JSON.stringify([propertyId, 42]),
        scopedRaw: null,
        serviceTierRaw: "standard",
      },
      {
        planPropertyIdsRaw: JSON.stringify([propertyId, propertyId]),
        scopedRaw: null,
        serviceTierRaw: "standard",
      },
      {
        planPropertyIdsRaw: JSON.stringify([propertyId]),
        scopedRaw: "0",
        serviceTierRaw: "standard",
      },
      {
        planPropertyIdsRaw: JSON.stringify([propertyId]),
        scopedRaw: null,
        serviceTierRaw: "unknown",
      },
    ];
    const expectedReasons = [
      "invalid-json",
      "invalid-shape",
      "invalid-shape",
      "duplicate-property-id",
      "invalid-shape",
      "invalid-shape",
    ] as const;
    expect(
      invalid.map((state) =>
        parseTransitionalWorkflowFinalizationManifest({
          expectedRequestId: requestId,
          ...state,
        }),
      ),
    ).toEqual(expectedReasons.map((reason) => ({ status: "corrupt", reason })));
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
        args: [
          `workflow-run:{${workspaceId}}:completed-entities`,
          `workflow-run:{${workspaceId}}:completed`,
        ],
      },
      {
        command: "SET",
        args: [`workflow-run:{${workspaceId}}:set-mode`, "1", "EX", "600"],
      },
      {
        command: "DEL",
        args: [
          `workflow-run:{${workspaceId}}:plan-properties`,
          `workflow-run:{${workspaceId}}:scoped`,
          `workflow-run:{${workspaceId}}:service-tier`,
        ],
      },
      {
        command: "SET",
        args: [`workflow-run:{${workspaceId}}:total`, "3", "EX", "600"],
      },
      {
        command: "SET",
        args: [
          `workflow-run:{${workspaceId}}:finalization-v1`,
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

  test("reads and preserves the immediately previous release state", async () => {
    const values = new Map<string, string>([
      [
        `workflow-run:{${workspaceId}}:plan-properties`,
        JSON.stringify([propertyId]),
      ],
      [`workflow-run:{${workspaceId}}:scoped`, "1"],
      [`workflow-run:{${workspaceId}}:service-tier`, "batch"],
    ]);
    const store = createWorkflowRunStateStore({
      send: async (command, args) =>
        command === "GET" ? (values.get(args[0] ?? "") ?? null) : null,
    });

    const result = await store.readFinalizationState({
      requestId,
      workspaceId,
    });

    expect(Result.isError(result)).toBe(false);
    if (!Result.isError(result)) {
      expect(result.value).toEqual({
        status: "available",
        manifest: {
          ...validManifest,
          freshnessScope: "cells",
          serviceTier: "batch",
        },
      });
    }
  });

  test("refreshes previous-release keys until transitional jobs age out", async () => {
    const keys: string[] = [];
    const store = createWorkflowRunStateStore({
      send: async (command, args) => {
        if (command === "EXPIRE") {
          keys.push(args[0] ?? "");
        }
        return 1;
      },
    });

    await store.refreshActiveLease({
      runLockTtlSec: 600,
      workspaceId,
    });

    expect(keys).toContain(`workflow-run:{${workspaceId}}:plan-properties`);
    expect(keys).toContain(`workflow-run:{${workspaceId}}:scoped`);
    expect(keys).toContain(`workflow-run:{${workspaceId}}:service-tier`);
    expect(keys).toContain(`workflow-run:{${workspaceId}}:completed`);
    expect(keys).toContain(`workflow-run:{${workspaceId}}:set-mode`);
  });

  test("recognizes a transitional constant-valued running lock", async () => {
    const values = new Map<string, string>([
      [`workflow-run:{${workspaceId}}:request-id`, requestId],
      [`workflow-run:{${workspaceId}}:running`, "1"],
    ]);
    const store = createWorkflowRunStateStore({
      send: async (command, args) =>
        command === "GET" ? (values.get(args[0] ?? "") ?? null) : null,
    });

    expect(await store.isCurrentRequest({ requestId, workspaceId })).toBe(true);
  });

  test("releases a claim by comparing the request id, not by deleting the key", async () => {
    const commands: { command: string; args: string[] }[] = [];
    const store = createWorkflowRunStateStore({
      send: async (command, args) => {
        commands.push({ command, args });
        return await Promise.resolve(1);
      },
    });

    expect(await store.releaseClaim({ requestId, workspaceId })).toBe(true);

    // One single-key script naming the running key and the id it may delete
    // for. A bare DEL would drop whatever holds the workspace when it lands,
    // which after a Valkey failure can be a replacement run's claim.
    expect(commands).toEqual([
      {
        command: "EVAL",
        args: [
          expect.any(String),
          "1",
          `workflow-run:{${workspaceId}}:running`,
          requestId,
        ],
      },
    ]);
    const script = commands.at(0)?.args.at(0) ?? "";
    expect(script).toContain('redis.call("GET", KEYS[1])');
    expect(script).toContain("ARGV[1]");
    expect(script).toContain('redis.call("DEL", KEYS[1])');
  });

  test("reports a claim that had already moved on as not released", async () => {
    const store = createWorkflowRunStateStore({
      send: async () => await Promise.resolve(0),
    });

    // The compare failed: the lock's TTL lapsed and someone else owns the
    // workspace now. Nothing was deleted, which is the point.
    expect(await store.releaseClaim({ requestId, workspaceId })).toBe(false);
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
