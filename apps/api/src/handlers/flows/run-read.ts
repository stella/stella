import { Result } from "better-result";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
import { flowRuns, flowRunSteps } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { MAX_FLOW_STEPS } from "@/api/lib/flows/flow-types";
import type { FlowRunStatus } from "@/api/lib/flows/flow-types";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedFlowRunId } from "@/api/lib/safe-id-boundaries";

// ── List (newest first, optional status filter) ─────────

const decodeFlowRunCursor = (cursor: string): SafeId<"flowRun"> | null => {
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 1) {
    return null;
  }
  const [rawId] = parts;
  if (!isUuidPaginationCursorPart(rawId)) {
    return null;
  }
  return brandPersistedFlowRunId(rawId);
};

type ListFlowRunsProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  query: { limit?: number; cursor?: string; status?: FlowRunStatus };
};

export const listFlowRunsHandler = async function* ({
  safeDb,
  workspaceId,
  query,
}: ListFlowRunsProps) {
  const limit = query.limit ?? LIMITS.flowRunsPageSizeDefault;
  const conditions = [eq(flowRuns.workspaceId, workspaceId)];
  if (query.status) {
    conditions.push(eq(flowRuns.status, query.status));
  }

  if (query.cursor) {
    const cursor = decodeFlowRunCursor(query.cursor);
    if (!cursor) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    const boundary = yield* Result.await(
      safeDb((tx) =>
        tx.query.flowRuns.findFirst({
          where: { id: { eq: cursor }, workspaceId: { eq: workspaceId } },
          columns: { id: true },
        }),
      ),
    );
    if (!boundary) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    conditions.push(
      sql`(${flowRuns.createdAt}, ${flowRuns.id}) < (select b.created_at, b.id from flow_runs b where b.id = ${cursor} and b.workspace_id = ${workspaceId})`,
    );
  }

  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          id: flowRuns.id,
          definitionId: flowRuns.definitionId,
          definitionSnapshot: flowRuns.definitionSnapshot,
          status: flowRuns.status,
          currentStepIndex: flowRuns.currentStepIndex,
          triggerSource: flowRuns.triggerSource,
          startedAt: flowRuns.startedAt,
          finishedAt: flowRuns.finishedAt,
          createdAt: flowRuns.createdAt,
        })
        .from(flowRuns)
        .where(and(...conditions))
        .orderBy(desc(flowRuns.createdAt), desc(flowRuns.id))
        .limit(limit + 1),
    ),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) => encodePaginationCursor([item.id]),
  });

  return Result.ok({
    ...page,
    items: page.items.map((row) => ({
      id: row.id,
      definitionId: row.definitionId,
      name: row.definitionSnapshot.name,
      status: row.status,
      currentStepIndex: row.currentStepIndex,
      stepCount: row.definitionSnapshot.steps.length,
      triggerType: row.triggerSource.type,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
  });
};

// ── Detail (run + ordered steps) ────────────────────────

type GetFlowRunProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"flowRun">;
};

export const getFlowRunHandler = async function* ({
  safeDb,
  workspaceId,
  runId,
}: GetFlowRunProps) {
  const run = yield* Result.await(
    safeDb((tx) =>
      tx.query.flowRuns.findFirst({
        where: { id: { eq: runId }, workspaceId: { eq: workspaceId } },
        columns: {
          id: true,
          definitionId: true,
          definitionSnapshot: true,
          status: true,
          currentStepIndex: true,
          triggerSource: true,
          inputEntityIds: true,
          error: true,
          startedAt: true,
          finishedAt: true,
          createdAt: true,
        },
      }),
    ),
  );

  if (!run) {
    return Result.err(
      new HandlerError({ status: 404, message: "Flow run not found" }),
    );
  }

  const steps = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          index: flowRunSteps.index,
          kind: flowRunSteps.kind,
          status: flowRunSteps.status,
          output: flowRunSteps.output,
          error: flowRunSteps.error,
          startedAt: flowRunSteps.startedAt,
          finishedAt: flowRunSteps.finishedAt,
        })
        .from(flowRunSteps)
        .where(eq(flowRunSteps.runId, runId))
        .orderBy(asc(flowRunSteps.index))
        // A run has at most MAX_FLOW_STEPS step rows (unique (runId, index),
        // snapshot length bounded at start), so this ordered read is bounded.
        .limit(MAX_FLOW_STEPS),
    ),
  );

  return Result.ok({
    id: run.id,
    definitionId: run.definitionId,
    name: run.definitionSnapshot.name,
    steps: run.definitionSnapshot.steps,
    status: run.status,
    currentStepIndex: run.currentStepIndex,
    triggerSource: run.triggerSource,
    inputEntityIds: run.inputEntityIds,
    error: run.error,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    stepRuns: steps.map((step) => ({
      index: step.index,
      kind: step.kind,
      status: step.status,
      output: step.output,
      error: step.error,
      startedAt: step.startedAt?.toISOString() ?? null,
      finishedAt: step.finishedAt?.toISOString() ?? null,
    })),
  });
};
