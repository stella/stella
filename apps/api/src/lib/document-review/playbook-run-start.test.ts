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

  test("an enqueue boundary failure is reported in band and refused", async () => {
    const releasedClaims: { requestId: string; workspaceId: string }[] = [];
    const result = await startWorkflow({
      workspaceId: WORKSPACE_ID,
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      scopedDb: asTestRaw<ScopedDb>(() => {
        throw new Error("planning must not run after kickoff fails");
      }),
      runStateStore: asTestRaw<
        NonNullable<Parameters<typeof startWorkflow>[0]["runStateStore"]>
      >({
        tryClaim: async () => true,
        releaseClaim: async (claim: (typeof releasedClaims)[number]) => {
          releasedClaims.push(claim);
          return true;
        },
      }),
      extractionRunStore: asTestRaw<
        Parameters<typeof startWorkflow>[0]["extractionRunStore"]
      >({}),
      kickoff: async () => {
        throw new Error("queue unavailable");
      },
    });

    expect(result).toEqual({ status: "failed" });
    expect(playbookRunStartOutcome(result.status)).toBe(
      PLAYBOOK_RUN_START_OUTCOME.NOT_STARTED,
    );
    expect(releasedClaims).toHaveLength(1);
    expect(releasedClaims.at(0)?.workspaceId).toBe(WORKSPACE_ID);
  });
});
