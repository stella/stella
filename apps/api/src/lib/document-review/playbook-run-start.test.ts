import { describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import {
  PLAYBOOK_RUN_START_OUTCOME,
  playbookRunStartOutcome,
} from "@/api/lib/document-review/playbook-run-start";
import {
  startWorkflow,
  WORKFLOW_START_STATUSES,
} from "@/api/lib/workflow-queue";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const WORKSPACE_ID = toSafeId<"workspace">(
  "01931f4a-0000-7000-8000-000000000101",
);
const ORGANIZATION_ID = toSafeId<"organization">(
  "01931f4a-0000-7000-8000-000000000102",
);
const USER_ID = toSafeId<"user">("01931f4a-0000-7000-8000-000000000103");

describe("classifying a playbook run's workflow start", () => {
  test("every queue status says whether work was queued, deferred, or refused", () => {
    const expectedOutcomes = [
      ["started", PLAYBOOK_RUN_START_OUTCOME.QUEUED],
      ["already-running", PLAYBOOK_RUN_START_OUTCOME.DEFERRED],
      ["skipped", PLAYBOOK_RUN_START_OUTCOME.DEFERRED],
      ["failed", PLAYBOOK_RUN_START_OUTCOME.NOT_STARTED],
    ] as const;

    expect([...WORKFLOW_START_STATUSES]).toEqual(
      expectedOutcomes.map(([status]) => status),
    );
    expect(
      expectedOutcomes.map(([status]) => [
        status,
        playbookRunStartOutcome(status),
      ]),
    ).toEqual(expectedOutcomes.map(([status, outcome]) => [status, outcome]));
  });

  test("an enqueue boundary failure is reported in band and cleans up the attempted jobs", async () => {
    const entityId = toSafeId<"entity">("01931f4a-0000-7000-8000-000000000104");
    const claimed: string[] = [];
    const enqueued: string[] = [];
    const removed: string[] = [];
    const cleared: string[] = [];
    const failedRuns: string[] = [];
    const transaction = asTestRaw<Parameters<Parameters<ScopedDb>[0]>[0]>({
      query: {
        properties: {
          findMany: async () => [
            {
              id: toSafeId<"property">("01931f4a-0000-7000-8000-000000000105"),
              status: "stale",
              content: { version: 1, type: "text", value: "x" },
              tool: { version: 1, type: "ai-model", prompt: "test" },
              dependencies: [
                {
                  dependsOnPropertyId: "01931f4a-0000-7000-8000-000000000106",
                  condition: null,
                },
              ],
            },
            {
              id: toSafeId<"property">("01931f4a-0000-7000-8000-000000000106"),
              status: "fresh",
              content: { version: 1, type: "file" },
              tool: { version: 1, type: "manual-input" },
              dependencies: [],
            },
          ],
        },
      },
      select: () => ({
        from: () => ({
          where: async () => [{ id: entityId, kind: "document" }],
        }),
      }),
    });
    const scopedDb: ScopedDb = async (read) => await read(transaction);
    const result = await startWorkflow({
      workspaceId: WORKSPACE_ID,
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      entityIds: [entityId],
      scopedDb,
      runStateStore: asTestRaw<
        NonNullable<Parameters<typeof startWorkflow>[0]["runStateStore"]>
      >({
        tryClaim: async ({ requestId }: { requestId: string }) => {
          claimed.push(requestId);
          return true;
        },
        setRequestId: async () => undefined,
        extendPlanningLease: async () => undefined,
        initializeCompletion: async () => undefined,
        clear: async (workspaceId: string) => {
          cleared.push(workspaceId);
        },
      }),
      extractionRunStore: {
        create: async () => undefined,
        start: async () => undefined,
        skip: async () => undefined,
        fail: async ({ id }) => {
          failedRuns.push(id);
        },
      },
      kickoff: async ({ run }) =>
        await run(new AbortController().signal, async () => undefined),
      queue: asTestRaw<
        NonNullable<Parameters<typeof startWorkflow>[0]["queue"]>
      >({
        addBulk: async (jobs: { opts: { jobId: string } }[]) => {
          enqueued.push(...jobs.map(({ opts }) => opts.jobId));
          throw new Error("queue unavailable");
        },
        remove: async (jobId: string) => {
          removed.push(jobId);
          return 1;
        },
      }),
    });

    // These reachability assertions prevent a planning failure from standing
    // in for the enqueue fault, or a cleanup-only failure from satisfying it.
    const claimedRunId = claimed.at(0);
    expect(claimedRunId).toBeDefined();
    if (claimedRunId === undefined) {
      return;
    }
    expect(enqueued).toEqual([`workflow-${claimedRunId}-${entityId}`]);
    expect(result).toEqual({ status: "failed" });
    expect(playbookRunStartOutcome(result.status)).toBe(
      PLAYBOOK_RUN_START_OUTCOME.NOT_STARTED,
    );
    expect(removed).toEqual(enqueued);
    expect(cleared).toEqual([WORKSPACE_ID]);
    expect(failedRuns).toEqual(claimed);
  });
});
