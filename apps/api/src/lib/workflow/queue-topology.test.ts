import { describe, expect, test } from "bun:test";

import {
  combineLiveWorkflowJobSnapshots,
  workflowQueueClassForServiceTier,
  WORKFLOW_QUEUE_CLASS,
  WORKFLOW_QUEUE_NAMES,
  WORKFLOW_WORKER_SPECS,
} from "@/api/lib/workflow/queue-topology";

describe("workflow queue topology", () => {
  test("keeps the legacy queue name distinct from the future flex queue", () => {
    expect(WORKFLOW_QUEUE_NAMES.standard).toBe("workflow");
    expect(WORKFLOW_QUEUE_NAMES.flex).not.toBe(WORKFLOW_QUEUE_NAMES.standard);
  });

  test("preserves legacy routing for every service tier", () => {
    expect(workflowQueueClassForServiceTier("standard")).toBe(
      WORKFLOW_QUEUE_CLASS.standard,
    );
    expect(workflowQueueClassForServiceTier("flex")).toBe(
      WORKFLOW_QUEUE_CLASS.standard,
    );
    expect(workflowQueueClassForServiceTier("batch")).toBe(
      WORKFLOW_QUEUE_CLASS.standard,
    );
  });

  test("gives each worker an explicit positive concurrency budget", () => {
    expect(WORKFLOW_WORKER_SPECS).toHaveLength(2);
    expect(WORKFLOW_WORKER_SPECS.map(({ queueClass }) => queueClass)).toEqual([
      WORKFLOW_QUEUE_CLASS.standard,
      WORKFLOW_QUEUE_CLASS.flex,
    ]);
    expect(
      new Set(WORKFLOW_WORKER_SPECS.map(({ queueClass }) => queueClass)).size,
    ).toBe(WORKFLOW_WORKER_SPECS.length);
    for (const spec of WORKFLOW_WORKER_SPECS) {
      expect(spec.concurrency).toBeGreaterThan(0);
    }
  });

  test("unions live workspaces across every queue and ignores empty IDs", () => {
    const snapshot = combineLiveWorkflowJobSnapshots({
      jobSnapshots: [
        [
          { data: { workspaceId: "workspace-standard" } },
          { data: { workspaceId: "" } },
        ],
        [
          { data: { workspaceId: "workspace-flex" } },
          { data: { workspaceId: "workspace-standard" } },
        ],
      ],
      scanLimit: 3,
    });

    expect(snapshot.workspaceIds).toEqual(
      new Set(["workspace-standard", "workspace-flex"]),
    );
    expect(snapshot.truncated).toBe(false);
  });

  test("marks the combined snapshot truncated when either queue reaches its limit", () => {
    const standardTruncated = combineLiveWorkflowJobSnapshots({
      jobSnapshots: [
        [
          { data: { workspaceId: "standard-a" } },
          { data: { workspaceId: "standard-b" } },
        ],
        [{ data: { workspaceId: "flex-a" } }],
      ],
      scanLimit: 2,
    });
    const flexTruncated = combineLiveWorkflowJobSnapshots({
      jobSnapshots: [
        [{ data: { workspaceId: "standard-a" } }],
        [
          { data: { workspaceId: "flex-a" } },
          { data: { workspaceId: "flex-b" } },
        ],
      ],
      scanLimit: 2,
    });

    expect(standardTruncated.truncated).toBe(true);
    expect(flexTruncated.truncated).toBe(true);
  });
});
