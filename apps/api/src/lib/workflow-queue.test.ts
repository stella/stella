import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { isTransientRedisConnectionError } from "@/api/lib/redis-client";
import {
  createWorkflowReconcileRunner,
  handleWorkflowReconcileFailure,
} from "@/api/lib/workflow-queue";
import { resolveWorkflowTargetEntityIds } from "@/api/lib/workflow-targets";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

const entityId = (value: string) => toSafeId<"entity">(value);

const documentA = entityId("entity_document_a");
const documentB = entityId("entity_document_b");
const folder = entityId("entity_folder");
const link = entityId("entity_link");
const message = entityId("entity_message");
const task = entityId("entity_task");

const entityRows = [
  { id: documentA, kind: "document" },
  { id: folder, kind: "folder" },
  { id: task, kind: "task" },
  { id: message, kind: "message" },
  { id: link, kind: "link" },
  { id: documentB, kind: "document" },
] as const;

describe("workflow entity targeting", () => {
  test("only targets document entities for full workspace runs", () => {
    expect(resolveWorkflowTargetEntityIds({ entityRows })).toEqual([
      documentA,
      documentB,
    ]);
  });

  test("keeps explicit non-folder entity IDs while preserving requested priority", () => {
    expect(
      resolveWorkflowTargetEntityIds({
        entityRows,
        inputEntityIds: [folder, task, documentB, link, documentA],
        inputOrder: [documentA, task],
      }),
    ).toEqual([documentA, task, documentB, link]);
  });

  test("deduplicates explicit targets before workflow jobs are counted", () => {
    expect(
      resolveWorkflowTargetEntityIds({
        entityRows,
        inputEntityIds: [
          documentA,
          task,
          documentA,
          folder,
          documentB,
          task,
          link,
        ],
        inputOrder: [task, task, documentB],
      }),
    ).toEqual([task, documentB, documentA, link]);
  });
});

// The runner hands its tick off to a floating promise chain, so an assertion
// has to wait for that chain to settle rather than for the call to return.
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

describe("workflow reconcile failures", () => {
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

  test("warns without capturing when the tick's socket was dropped", () => {
    // The transient and non-transient fixtures must classify differently, or
    // both assertions below would pass through the same branch.
    const transient = Object.assign(new Error("Connection closed"), {
      code: "ERR_REDIS_CONNECTION_CLOSED",
    });
    const defect = Object.assign(new Error("WRONGTYPE"), {
      code: "ERR_REDIS_INVALID_TYPE",
    });
    expect(isTransientRedisConnectionError(transient)).toBe(true);
    expect(isTransientRedisConnectionError(defect)).toBe(false);

    handleWorkflowReconcileFailure(transient);
    expect(analytics.exceptions()).toEqual([]);
    expect(logs.at("WARN")).toMatchObject([
      {
        message: "workflow.reconcile_disrupted",
        attributes: { "error.type": "Error" },
      },
    ]);
    expect(logs.at("ERROR")).toEqual([]);

    handleWorkflowReconcileFailure(defect);
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      { "error.class": "Error", "error.code": "ERR_REDIS_INVALID_TYPE" },
    ]);
    expect(logs.at("ERROR")).toMatchObject([
      { message: "workflow.reconcile_failed" },
    ]);
    // The defect took the capture branch, so no second disruption warning.
    expect(logs.at("WARN")).toHaveLength(1);
  });

  test("keeps the pending-cell sweep owed until a tick completes", async () => {
    const scans: boolean[] = [];
    let disrupted = true;
    const runReconcile = createWorkflowReconcileRunner(
      async ({ scanPendingCells }) => {
        scans.push(scanPendingCells);
        await (disrupted
          ? Promise.reject(
              Object.assign(new Error("Connection closed"), {
                code: "ERR_REDIS_CONNECTION_CLOSED",
              }),
            )
          : Promise.resolve());
      },
    );

    runReconcile();
    await settle();
    // The disrupted tick never swept, so the next one must sweep again.
    expect(scans).toEqual([true]);

    disrupted = false;
    runReconcile();
    await settle();
    expect(scans).toEqual([true, true]);

    // One completed sweep discharges it; later ticks stay on the bounded scan.
    runReconcile();
    await settle();
    expect(scans).toEqual([true, true, false]);
    expect(analytics.exceptions()).toEqual([]);
  });
});
