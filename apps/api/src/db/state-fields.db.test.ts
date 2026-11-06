import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { FLOW_RUN_STATUSES, isTerminalFlowRunStatus } from "@stll/api-contract";
import type { FlowRunStatus } from "@stll/api-contract";
import { rejectionOf } from "@stll/property-testing/rejection";
import { createTestClock } from "@stll/test-kit";

import { organization } from "@/api/db/auth-schema";
import { flowRuns, flowRunSteps, workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { isPgConstraintError } from "@/api/lib/pg-error";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { flowRunStateFields } from "@/api/tests/helpers/flow-state-fields";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const stateClock = createTestClock();

const CHECK_VIOLATION = "23514";
const RUN_CHECK = "flow_runs_state_fields_check";
const STEP_CHECK = "flow_run_steps_state_fields_check";

const organizationId = mintAuthProviderId<"organization">();
const workspaceId = createSafeId<"workspace">();
let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(organization).values({
    id: organizationId,
    name: "State fields fixture",
    slug: organizationId,
    createdAt: new Date(stateClock.now()),
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "State fields matter",
    reference: workspaceId,
  });
});

afterAll(async () => {
  await client.close();
});

type RunFields = ReturnType<typeof flowRunStateFields>;

const insertRun = async (status: FlowRunStatus, fields: RunFields) => {
  const id = createSafeId<"flowRun">();
  await db.insert(flowRuns).values({
    id,
    workspaceId,
    status,
    definitionSnapshot: { name: "State fields", steps: [] },
    triggerSource: { type: "schedule" },
    ...fields,
  });
  return id;
};

test("every flow run status accepts the shape the engine writes", async () => {
  for (const status of FLOW_RUN_STATUSES) {
    const id = await insertRun(status, flowRunStateFields(status));
    expect(
      (await db.select().from(flowRuns).where(eq(flowRuns.id, id))).at(0)
        ?.status,
    ).toBe(status);
  }
});

test("a flow run cannot carry fields that belong to another state", async () => {
  const at = new Date(stateClock.now());
  const violations: { status: FlowRunStatus; fields: RunFields }[] = [
    // Only a failed run explains itself with an error.
    ...FLOW_RUN_STATUSES.filter((status) => status !== "failed").map(
      (status) => ({
        status,
        fields: { ...flowRunStateFields(status), error: "Stray error" },
      }),
    ),
    {
      status: "failed",
      fields: { ...flowRunStateFields("failed"), error: null },
    },
    // A terminal run records when it finished; an active one has not.
    ...FLOW_RUN_STATUSES.filter(isTerminalFlowRunStatus).map((status) => ({
      status,
      fields: { ...flowRunStateFields(status), finishedAt: null },
    })),
    ...FLOW_RUN_STATUSES.filter(
      (status) => !isTerminalFlowRunStatus(status),
    ).map((status) => ({
      status,
      fields: { ...flowRunStateFields(status), finishedAt: at },
    })),
    // A run that left pending has started.
    ...(["running", "awaiting_review"] as const).map((status) => ({
      status,
      fields: { ...flowRunStateFields(status), startedAt: null },
    })),
  ];
  for (const { status, fields } of violations) {
    const error = await rejectionOf(insertRun(status, fields));
    expect(isPgConstraintError(error, CHECK_VIOLATION, RUN_CHECK)).toBe(true);
  }
});

test("a pending flow run step has no progress and a failed one has its error", async () => {
  const runId = await insertRun("running", flowRunStateFields("running"));
  const at = new Date(stateClock.now());
  const insertStep = async (fields: {
    status: "pending" | "failed";
    startedAt?: Date;
    finishedAt?: Date;
    error?: string;
  }) =>
    await db.insert(flowRunSteps).values({
      id: createSafeId<"flowRunStep">(),
      workspaceId,
      runId,
      index: 0,
      kind: "ai",
      ...fields,
    });
  for (const fields of [
    { status: "pending", startedAt: at },
    { status: "pending", error: "Stray error" },
    { status: "failed", startedAt: at, finishedAt: at },
  ] as const) {
    const error = await rejectionOf(insertStep(fields));
    expect(isPgConstraintError(error, CHECK_VIOLATION, STEP_CHECK)).toBe(true);
  }
});
