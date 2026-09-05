import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { USAGE_SERVICE_TIERS } from "@/api/db/schema";
import type { AIRequestServiceTier } from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import {
  coordinationExpireArguments,
  coordinationKey,
  coordinationSetArguments,
  type CoordinationKey,
} from "@/api/lib/redis-keys";
import { brandPersistedPropertyId } from "@/api/lib/safe-id-boundaries";
import {
  recordEntityCompletion,
  resetCompletionState,
} from "@/api/lib/workflow/completion-tracking";
import type { EntityCompletionReply } from "@/api/lib/workflow/completion-tracking";
import {
  isCurrentWorkflowRequestState,
  parseRunningLockWorkspaceId,
  selectRunningLockReservation,
} from "@/api/lib/workflow/orphan-recovery";

const WORKFLOW_RUN_SCOPE = "workflow-run";
const FINALIZATION_MANIFEST_VERSION = 1;
const TRANSITIONAL_RUNNING_LOCK_VALUE = "1";
// Derived from the key builder so the glob cannot drift from the key layout.
const RUNNING_LOCK_SCAN_PATTERN = coordinationKey({
  scope: WORKFLOW_RUN_SCOPE,
  slot: "*",
  suffix: "running",
});
const RUNNING_LOCK_SCAN_COUNT = "200";
// Compare-and-delete on one key: the claim is released only while it still
// holds the releasing request's id. An unconditional DEL would be correct only
// if no time passed between claiming and releasing, and this path runs after a
// Valkey failure — long enough for the lock's TTL to lapse and a replacement
// run to claim the workspace, whose claim the DEL would then drop.
const RELEASE_CLAIM_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;
const RESERVE_RECOVERY_LOCK_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current == ARGV[1] then
  redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
  return 1
end
return 0
`;

const CURRENT_WORKFLOW_RUN_STATE_FIELDS = [
  "running",
  "total",
  "completed-entities",
  "finalization-v1",
  "request-id",
] as const;

// Transitional keys written by the immediately preceding release. BullMQ
// jobs survive the API process shutdown's bounded drain, so a new worker can
// finish a run that was started by that release even when replicas never
// overlap. Keep these keys only until every pre-finalization-v1 job and TTL has
// aged out; they are parsed strictly and never restore workspace-wide fallback.
const TRANSITIONAL_FINALIZATION_FIELDS = [
  "plan-properties",
  "scoped",
  "service-tier",
] as const;

const TRANSITIONAL_COMPLETION_FIELDS = ["completed", "set-mode"] as const;

const WORKFLOW_RUN_STATE_FIELDS = [
  ...CURRENT_WORKFLOW_RUN_STATE_FIELDS,
  ...TRANSITIONAL_FINALIZATION_FIELDS,
  ...TRANSITIONAL_COMPLETION_FIELDS,
] as const;

const workflowFinalizationManifestSchema = v.strictObject({
  version: v.literal(FINALIZATION_MANIFEST_VERSION),
  requestId: v.pipe(v.string(), v.uuid()),
  freshnessScope: v.picklist(["workspace", "cells"]),
  propertyIds: v.pipe(v.array(v.pipe(v.string(), v.uuid())), v.nonEmpty()),
  serviceTier: v.picklist(USAGE_SERVICE_TIERS),
});

const transitionalPropertyIdsSchema = v.pipe(
  v.array(v.pipe(v.string(), v.uuid())),
  v.nonEmpty(),
);
const transitionalServiceTierSchema = v.picklist(USAGE_SERVICE_TIERS);

export type WorkflowFinalizationManifest = {
  version: typeof FINALIZATION_MANIFEST_VERSION;
  requestId: string;
  freshnessScope: "workspace" | "cells";
  propertyIds: readonly SafeId<"property">[];
  serviceTier: AIRequestServiceTier;
};

export type WorkflowFinalizationState =
  | { status: "available"; manifest: WorkflowFinalizationManifest }
  | { status: "missing" }
  | {
      status: "corrupt";
      reason:
        | "invalid-json"
        | "invalid-shape"
        | "duplicate-property-id"
        | "request-mismatch";
    };

export class WorkflowRunStateUnavailableError extends TaggedError(
  "WorkflowRunStateUnavailableError",
)<{
  message: string;
  cause: unknown;
  workspaceId: SafeId<"workspace">;
}> {}

export class WorkflowRunStateInvalidError extends TaggedError(
  "WorkflowRunStateInvalidError",
)<{
  message: string;
  reason:
    | "missing"
    | Extract<WorkflowFinalizationState, { status: "corrupt" }>["reason"];
  workspaceId: SafeId<"workspace">;
}> {}

type WorkflowRunStateRedis = {
  send: (command: string, args: string[]) => Promise<unknown>;
};

type WorkflowRunStateField = (typeof WORKFLOW_RUN_STATE_FIELDS)[number];

// The workspace is the colocation unit: `clear`, `initializeCompletion` and
// COMPLETE_ENTITY_SCRIPT each touch several of these keys in one command, and
// a cluster rejects a multi-key command whose keys span slots. Hashtagging the
// workspace id keeps every field of one run on one node while distinct
// workspaces still spread across the ring.
//
// Deploying this rename moves every lookup off `workflow:<workspaceId>:<field>`
// with no transitional read, which is safe for run state but not free during a
// rolling deploy. A run in flight across the deploy is recovered, not lost:
// its jobs stop matching the request id, its cells stay pending, and the boot
// pass of `reconcileOrphanedWorkflows` (`scanPendingCells: true`, which every
// replica runs as it starts) rebuilds the workspace from PostgreSQL rather
// than from the lock. What the rename does drop for the length of the rollout
// is mutual exclusion between the two releases: a replica on the old code
// holds the old `running` key while a replica on the new code claims the new
// one, so a workspace with a pre-deploy run in flight can accept a second run
// started in that window. The result is duplicated extraction work over the
// same cells, not corrupted state, and the old keys expire on their own TTL.
// Deploy while workflow runs are idle to avoid it entirely.
const workflowKey = (
  workspaceId: SafeId<"workspace">,
  field: WorkflowRunStateField,
): CoordinationKey =>
  coordinationKey({
    scope: WORKFLOW_RUN_SCOPE,
    slot: workspaceId,
    suffix: field,
  });

const parseOptionalStringReply = (reply: unknown): string | null => {
  if (reply === null || typeof reply === "string") {
    return reply;
  }
  throw new TypeError("Redis GET returned a non-string workflow value");
};

const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

export const parseWorkflowFinalizationManifest = ({
  expectedRequestId,
  raw,
}: {
  expectedRequestId: string;
  raw: string | null;
}): WorkflowFinalizationState => {
  if (raw === null) {
    return { status: "missing" };
  }
  const json = Result.try({
    try: (): unknown => JSON.parse(raw),
    catch: (cause) => cause,
  });
  if (Result.isError(json)) {
    return { status: "corrupt", reason: "invalid-json" };
  }
  const parsed = v.safeParse(workflowFinalizationManifestSchema, json.value);
  if (!parsed.success) {
    return { status: "corrupt", reason: "invalid-shape" };
  }
  if (
    new Set(parsed.output.propertyIds).size !== parsed.output.propertyIds.length
  ) {
    return { status: "corrupt", reason: "duplicate-property-id" };
  }
  if (parsed.output.requestId !== expectedRequestId) {
    return { status: "corrupt", reason: "request-mismatch" };
  }
  return {
    status: "available",
    manifest: {
      version: FINALIZATION_MANIFEST_VERSION,
      requestId: parsed.output.requestId,
      freshnessScope: parsed.output.freshnessScope,
      propertyIds: parsed.output.propertyIds.map(brandPersistedPropertyId),
      serviceTier: parsed.output.serviceTier,
    },
  };
};

export const parseTransitionalWorkflowFinalizationManifest = ({
  expectedRequestId,
  planPropertyIdsRaw,
  scopedRaw,
  serviceTierRaw,
}: {
  expectedRequestId: string;
  planPropertyIdsRaw: string | null;
  scopedRaw: string | null;
  serviceTierRaw: string | null;
}): WorkflowFinalizationState => {
  if (
    planPropertyIdsRaw === null &&
    scopedRaw === null &&
    serviceTierRaw === null
  ) {
    return { status: "missing" };
  }
  if (
    planPropertyIdsRaw === null ||
    (scopedRaw !== null && scopedRaw !== "1") ||
    serviceTierRaw === null
  ) {
    return { status: "corrupt", reason: "invalid-shape" };
  }

  const propertyIdsJson = Result.try({
    try: (): unknown => JSON.parse(planPropertyIdsRaw),
    catch: (cause) => cause,
  });
  if (Result.isError(propertyIdsJson)) {
    return { status: "corrupt", reason: "invalid-json" };
  }
  const propertyIds = v.safeParse(
    transitionalPropertyIdsSchema,
    propertyIdsJson.value,
  );
  const serviceTier = v.safeParse(
    transitionalServiceTierSchema,
    serviceTierRaw,
  );
  if (!propertyIds.success || !serviceTier.success) {
    return { status: "corrupt", reason: "invalid-shape" };
  }
  if (new Set(propertyIds.output).size !== propertyIds.output.length) {
    return { status: "corrupt", reason: "duplicate-property-id" };
  }

  return {
    status: "available",
    manifest: {
      version: FINALIZATION_MANIFEST_VERSION,
      requestId: expectedRequestId,
      freshnessScope: scopedRaw === "1" ? "cells" : "workspace",
      propertyIds: propertyIds.output.map(brandPersistedPropertyId),
      serviceTier: serviceTier.output,
    },
  };
};

export const requireWorkflowFinalizationManifest = ({
  state,
  workspaceId,
}: {
  state: WorkflowFinalizationState;
  workspaceId: SafeId<"workspace">;
}): Result<WorkflowFinalizationManifest, WorkflowRunStateInvalidError> => {
  if (state.status === "available") {
    return Result.ok(state.manifest);
  }
  const reason = state.status === "missing" ? "missing" : state.reason;
  return Result.err(
    new WorkflowRunStateInvalidError({
      message: `Workflow finalization state is ${reason}`,
      reason,
      workspaceId,
    }),
  );
};

export const createWorkflowRunStateStore = (redis: WorkflowRunStateRedis) => {
  const getOptionalString = async (
    workspaceId: SafeId<"workspace">,
    field: WorkflowRunStateField,
  ): Promise<string | null> =>
    parseOptionalStringReply(
      await redis.send("GET", [workflowKey(workspaceId, field)]),
    );

  const readFinalizationState = async ({
    requestId,
    workspaceId,
  }: {
    requestId: string;
    workspaceId: SafeId<"workspace">;
  }): Promise<
    Result<WorkflowFinalizationState, WorkflowRunStateUnavailableError>
  > => {
    const raw = await Result.tryPromise({
      try: async () => await getOptionalString(workspaceId, "finalization-v1"),
      catch: (cause) =>
        new WorkflowRunStateUnavailableError({
          message: "Workflow finalization state is unavailable",
          cause,
          workspaceId,
        }),
    });
    if (Result.isError(raw)) {
      return Result.err(raw.error);
    }
    if (raw.value !== null) {
      return Result.ok(
        parseWorkflowFinalizationManifest({
          expectedRequestId: requestId,
          raw: raw.value,
        }),
      );
    }

    const transitionalRaw = await Result.tryPromise({
      try: async () =>
        await Promise.all([
          getOptionalString(workspaceId, "plan-properties"),
          getOptionalString(workspaceId, "scoped"),
          getOptionalString(workspaceId, "service-tier"),
        ]),
      catch: (cause) =>
        new WorkflowRunStateUnavailableError({
          message: "Transitional workflow finalization state is unavailable",
          cause,
          workspaceId,
        }),
    });
    if (Result.isError(transitionalRaw)) {
      return Result.err(transitionalRaw.error);
    }
    const [planPropertyIdsRaw, scopedRaw, serviceTierRaw] =
      transitionalRaw.value;
    return Result.ok(
      parseTransitionalWorkflowFinalizationManifest({
        expectedRequestId: requestId,
        planPropertyIdsRaw,
        scopedRaw,
        serviceTierRaw,
      }),
    );
  };

  return {
    clear: async (workspaceId: SafeId<"workspace">): Promise<void> => {
      await redis.send(
        "DEL",
        WORKFLOW_RUN_STATE_FIELDS.map((field) =>
          workflowKey(workspaceId, field),
        ),
      );
    },

    extendPlanningLease: async ({
      runLockTtlSec,
      workspaceId,
    }: {
      runLockTtlSec: number;
      workspaceId: SafeId<"workspace">;
    }): Promise<void> => {
      await Promise.all([
        redis.send(
          "EXPIRE",
          coordinationExpireArguments(
            workflowKey(workspaceId, "running"),
            runLockTtlSec,
          ),
        ),
        redis.send(
          "EXPIRE",
          coordinationExpireArguments(
            workflowKey(workspaceId, "request-id"),
            runLockTtlSec,
          ),
        ),
      ]);
    },

    getRequestId: async (
      workspaceId: SafeId<"workspace">,
    ): Promise<string | null> =>
      await getOptionalString(workspaceId, "request-id"),

    getRunningValue: async (
      workspaceId: SafeId<"workspace">,
    ): Promise<string | null> =>
      await getOptionalString(workspaceId, "running"),

    initializeCompletion: async ({
      manifest,
      runLockTtlSec,
      targetCount,
      workspaceId,
    }: {
      manifest: WorkflowFinalizationManifest;
      runLockTtlSec: number;
      targetCount: number;
      workspaceId: SafeId<"workspace">;
    }): Promise<void> => {
      await resetCompletionState({
        redis,
        completedEntitiesKey: workflowKey(workspaceId, "completed-entities"),
        transitionalCompletedKey: workflowKey(workspaceId, "completed"),
        setModeKey: workflowKey(workspaceId, "set-mode"),
        runStateTtlSec: runLockTtlSec,
      });
      await redis.send(
        "DEL",
        TRANSITIONAL_FINALIZATION_FIELDS.map((field) =>
          workflowKey(workspaceId, field),
        ),
      );
      await Promise.all([
        redis.send(
          "SET",
          coordinationSetArguments({
            key: workflowKey(workspaceId, "total"),
            value: String(targetCount),
            ttl: { unit: "seconds", value: runLockTtlSec },
          }),
        ),
        redis.send(
          "SET",
          coordinationSetArguments({
            key: workflowKey(workspaceId, "finalization-v1"),
            value: JSON.stringify(manifest),
            ttl: { unit: "seconds", value: runLockTtlSec },
          }),
        ),
      ]);
    },

    isCurrentRequest: async ({
      requestId,
      workspaceId,
    }: {
      requestId: string;
      workspaceId: SafeId<"workspace">;
    }): Promise<boolean> => {
      const [currentRequestId, runningValue] = await Promise.all([
        getOptionalString(workspaceId, "request-id"),
        getOptionalString(workspaceId, "running"),
      ]);
      return isCurrentWorkflowRequestState({
        currentRequestId,
        requestId,
        runningValue,
        transitionalRunningLockValue: TRANSITIONAL_RUNNING_LOCK_VALUE,
      });
    },

    isRunning: async (workspaceId: SafeId<"workspace">): Promise<boolean> =>
      (await getOptionalString(workspaceId, "running")) !== null,

    readFinalizationState,

    recordEntityCompletion: async ({
      entityId,
      requestId,
      runLockTtlSec,
      workspaceId,
    }: {
      entityId: SafeId<"entity">;
      requestId: string;
      runLockTtlSec: number;
      workspaceId: SafeId<"workspace">;
    }): Promise<EntityCompletionReply> =>
      await recordEntityCompletion({
        redis,
        keys: {
          requestId: workflowKey(workspaceId, "request-id"),
          running: workflowKey(workspaceId, "running"),
          completedEntities: workflowKey(workspaceId, "completed-entities"),
          total: workflowKey(workspaceId, "total"),
          transitionalCompleted: workflowKey(workspaceId, "completed"),
          setMode: workflowKey(workspaceId, "set-mode"),
        },
        activeRequestId: requestId,
        transitionalRunningLockValue: TRANSITIONAL_RUNNING_LOCK_VALUE,
        entityId,
        runStateTtlSec: runLockTtlSec,
      }),

    reserveForRecovery: async ({
      expectedRequestId,
      recoveryLockValue,
      runLockTtlSec,
      workspaceId,
    }: {
      expectedRequestId: string | null;
      recoveryLockValue: string;
      runLockTtlSec: number;
      workspaceId: SafeId<"workspace">;
    }): Promise<boolean> => {
      const runningKey = workflowKey(workspaceId, "running");
      const wasSet =
        (await redis.send(
          "SET",
          coordinationSetArguments({
            key: runningKey,
            value: recoveryLockValue,
            ttl: { unit: "seconds", value: runLockTtlSec },
            onlyIfAbsent: true,
          }),
        )) === "OK";
      if (wasSet) {
        const requestId = await getOptionalString(workspaceId, "request-id");
        if (requestId === expectedRequestId) {
          return true;
        }
        await redis.send("DEL", [runningKey]);
        return false;
      }

      const [runningValue, requestId] = await Promise.all([
        getOptionalString(workspaceId, "running"),
        getOptionalString(workspaceId, "request-id"),
      ]);
      if (runningValue === null || requestId !== expectedRequestId) {
        return false;
      }
      const reservation = selectRunningLockReservation({
        expectedRequestId,
        recoveryLockValue,
        requestId,
        runningValue,
        transitionalRunningLockValue: TRANSITIONAL_RUNNING_LOCK_VALUE,
      });
      if (reservation.status === "skip") {
        return false;
      }
      const reply = await redis.send("EVAL", [
        RESERVE_RECOVERY_LOCK_SCRIPT,
        "1",
        runningKey,
        reservation.expectedRunningValue,
        recoveryLockValue,
        String(runLockTtlSec),
      ]);
      return Number(reply) === 1;
    },

    /**
     * Give up a claim this request made and never got to use. Answers whether
     * the claim was still ours: `false` means the lock had already moved on
     * (its TTL lapsed, or a reconciler reserved it), which is why the delete
     * is conditional rather than a `clear`.
     *
     * Only the `running` key: a request that never started wrote nothing else,
     * and the request-id write it was attempting carries the same TTL.
     */
    releaseClaim: async ({
      requestId,
      workspaceId,
    }: {
      requestId: string;
      workspaceId: SafeId<"workspace">;
    }): Promise<boolean> =>
      Number(
        await redis.send("EVAL", [
          RELEASE_CLAIM_SCRIPT,
          "1",
          workflowKey(workspaceId, "running"),
          requestId,
        ]),
      ) === 1,

    refreshActiveLease: async ({
      runLockTtlSec,
      workspaceId,
    }: {
      runLockTtlSec: number;
      workspaceId: SafeId<"workspace">;
    }): Promise<void> => {
      await Promise.all(
        WORKFLOW_RUN_STATE_FIELDS.filter(
          (field) => field !== "completed-entities",
        ).map(
          async (field) =>
            await redis.send(
              "EXPIRE",
              coordinationExpireArguments(
                workflowKey(workspaceId, field),
                runLockTtlSec,
              ),
            ),
        ),
      );
    },

    setRequestId: async ({
      requestId,
      runLockTtlSec,
      workspaceId,
    }: {
      requestId: string;
      runLockTtlSec: number;
      workspaceId: SafeId<"workspace">;
    }): Promise<void> => {
      await redis.send(
        "SET",
        coordinationSetArguments({
          key: workflowKey(workspaceId, "request-id"),
          value: requestId,
          ttl: { unit: "seconds", value: runLockTtlSec },
        }),
      );
    },

    /**
     * Running locks visible to this connection. A cluster scans one node per
     * cursor, so this is a hint that accelerates reconciliation, never the
     * only way an orphaned run is found: `reconcileOrphanedWorkflows` also
     * derives candidates from pending cells and stale extraction-run rows in
     * PostgreSQL, and those two durable sources are what make the reconciler
     * complete.
     */
    scanRunningWorkspaceIds: async (): Promise<string[]> => {
      const workspaceIds: string[] = [];
      let cursor = "0";
      do {
        const reply = await redis.send("SCAN", [
          cursor,
          "MATCH",
          RUNNING_LOCK_SCAN_PATTERN,
          "COUNT",
          RUNNING_LOCK_SCAN_COUNT,
        ]);
        if (!isUnknownArray(reply) || reply.length < 2) {
          break;
        }
        const nextCursor = reply[0];
        const keys = reply[1];
        if (typeof nextCursor !== "string" || !isUnknownArray(keys)) {
          break;
        }
        for (const key of keys) {
          if (typeof key !== "string") {
            continue;
          }
          const workspaceId = parseRunningLockWorkspaceId(key);
          if (workspaceId !== null) {
            workspaceIds.push(workspaceId);
          }
        }
        cursor = nextCursor;
      } while (cursor !== "0");
      return workspaceIds;
    },

    tryClaim: async ({
      requestId,
      runLockTtlSec,
      workspaceId,
    }: {
      requestId: string;
      runLockTtlSec: number;
      workspaceId: SafeId<"workspace">;
    }): Promise<boolean> =>
      (await redis.send(
        "SET",
        coordinationSetArguments({
          key: workflowKey(workspaceId, "running"),
          value: requestId,
          ttl: { unit: "seconds", value: runLockTtlSec },
          onlyIfAbsent: true,
        }),
      )) === "OK",
  };
};

export type WorkflowRunStateStore = ReturnType<
  typeof createWorkflowRunStateStore
>;
