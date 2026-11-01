import { panic } from "better-result";
import * as v from "valibot";

import { pendingScoutEmissions } from "@/api/db/schema";
import type { SchedulerPayload } from "@/api/db/schema";
import { setSharedStatementTimeout } from "@/api/db/shared-pool-timeouts";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  AUTH_PROVIDER_ID_PATTERN,
  brandPersistedDocumentReviewRunId,
  brandPersistedEntityId,
  brandPersistedFlowDefinitionId,
  brandPersistedOrganizationId,
} from "@/api/lib/safe-id-boundaries";
import type { SchedulerDb, SchedulerJob } from "@/api/lib/scheduler/types";
import { checkpointRecoverySchedulerJob } from "@/api/lib/scheduler/upsert-job";

import {
  RECOVERY_SCAN_IDENTITIES,
  RECOVERY_SCAN_PHASES,
} from "./recovery-scan-identity";

const RECOVERY_SCAN_KEY = "recoveryScan";
const organizationIdSchema = v.pipe(
  v.string(),
  v.regex(AUTH_PROVIDER_ID_PATTERN),
  v.transform(brandPersistedOrganizationId),
);
const uploadCursorSchema = v.strictObject({
  definitionId: v.pipe(
    v.string(),
    v.uuid(),
    v.transform(brandPersistedFlowDefinitionId),
  ),
  entityId: v.pipe(v.string(), v.uuid(), v.transform(brandPersistedEntityId)),
});
type ScoutSourceKind =
  (typeof pendingScoutEmissions.sourceKind.enumValues)[number];
const scoutSourceIdSchemas = {
  "document-review": v.pipe(
    v.string(),
    v.uuid(),
    v.transform(brandPersistedDocumentReviewRunId),
  ),
  "infosoud-hearing": v.pipe(
    v.string(),
    v.uuid(),
    v.transform(brandPersistedEntityId),
  ),
} satisfies Record<ScoutSourceKind, v.GenericSchema>;
const scoutCursorVariants = pendingScoutEmissions.sourceKind.enumValues.map(
  (sourceKind) =>
    v.strictObject({
      organizationId: organizationIdSchema,
      sourceKind: v.literal(sourceKind),
      sourceId: scoutSourceIdSchemas[sourceKind],
    }),
);
const scoutCursorSchema = v.variant("sourceKind", scoutCursorVariants);
const phaseSchema = v.picklist(Object.values(RECOVERY_SCAN_PHASES));
const uploadStateSchema = v.strictObject({
  phase: phaseSchema,
  census: v.nullable(uploadCursorSchema),
  dispatch: v.nullable(uploadCursorSchema),
});
const scoutStateSchema = v.strictObject({
  phase: phaseSchema,
  census: v.nullable(scoutCursorSchema),
  dispatch: v.nullable(scoutCursorSchema),
});

export type UploadRecoveryCursor = v.InferOutput<typeof uploadCursorSchema>;
export type ScoutRecoveryCursor = v.InferOutput<typeof scoutCursorSchema>;
export type UploadRecoveryState = v.InferOutput<typeof uploadStateSchema>;
export type ScoutRecoveryState = v.InferOutput<typeof scoutStateSchema>;

type ScoutRecoveryRow = {
  organizationId: ScoutRecoveryCursor["organizationId"];
  sourceKind: ScoutSourceKind;
  sourceId: string;
};

/** A pending scout emission's position, with its id branded by source kind. */
export const scoutRecoveryCursorFor = ({
  organizationId,
  sourceKind,
  sourceId,
}: ScoutRecoveryRow): ScoutRecoveryCursor => {
  switch (sourceKind) {
    case "document-review":
      return {
        organizationId,
        sourceKind,
        sourceId: brandPersistedDocumentReviewRunId(sourceId),
      };
    case "infosoud-hearing":
      return {
        organizationId,
        sourceKind,
        sourceId: brandPersistedEntityId(sourceId),
      };
    default:
      sourceKind satisfies never;
      return panic("Unknown scout recovery source kind");
  }
};

type RecoveryTask =
  | {
      type: "upload";
      jobId: typeof RECOVERY_SCAN_IDENTITIES.upload.jobId;
      task: typeof RECOVERY_SCAN_IDENTITIES.upload.task;
    }
  | {
      type: "scout";
      jobId: typeof RECOVERY_SCAN_IDENTITIES.scout.jobId;
      task: typeof RECOVERY_SCAN_IDENTITIES.scout.task;
    };

const recoveryTaskFor = (
  job: Pick<SchedulerJob, "id" | "task">,
): RecoveryTask => {
  if (
    job.id === RECOVERY_SCAN_IDENTITIES.upload.jobId &&
    job.task === RECOVERY_SCAN_IDENTITIES.upload.task
  ) {
    return { type: "upload", ...RECOVERY_SCAN_IDENTITIES.upload };
  }
  if (
    job.id === RECOVERY_SCAN_IDENTITIES.scout.jobId &&
    job.task === RECOVERY_SCAN_IDENTITIES.scout.task
  ) {
    return { type: "scout", ...RECOVERY_SCAN_IDENTITIES.scout };
  }
  return panic("Recovery scan cursor used by an unregistered scheduler job", {
    jobId: job.id,
    task: job.task,
  });
};

export const readRecoveryScanState = (
  job: Pick<SchedulerJob, "id" | "task">,
  payload: SchedulerPayload | null,
): RecoveryScanState => {
  const task = recoveryTaskFor(job);
  const stored = payload?.[RECOVERY_SCAN_KEY];
  if (stored === undefined) {
    return task.type === "upload"
      ? {
          type: "upload",
          value: {
            phase: RECOVERY_SCAN_PHASES.census,
            census: null,
            dispatch: null,
          },
        }
      : {
          type: "scout",
          value: {
            phase: RECOVERY_SCAN_PHASES.census,
            census: null,
            dispatch: null,
          },
        };
  }
  if (task.type === "upload") {
    const parsed = v.safeParse(uploadStateSchema, stored);
    if (!parsed.success) {
      return panic("Recovery scan cursor payload is invalid", {
        jobId: job.id,
      });
    }
    return { type: "upload", value: parsed.output };
  }
  const parsed = v.safeParse(scoutStateSchema, stored);
  if (!parsed.success) {
    return panic("Recovery scan cursor payload is invalid", { jobId: job.id });
  }
  return { type: "scout", value: parsed.output };
};

type RecoveryCursorCheckpointOptions = {
  database: SchedulerDb;
  job: Pick<SchedulerJob, "id" | "task" | "lockedBy">;
  statementTimeoutMs: number;
  state:
    | { type: "upload"; value: UploadRecoveryState }
    | { type: "scout"; value: ScoutRecoveryState };
};

/** Update only this owner's cursor while preserving other registered payload fields. */
export const checkpointRecoveryScan = async ({
  database,
  job,
  statementTimeoutMs,
  state,
}: RecoveryCursorCheckpointOptions): Promise<boolean> => {
  const task = recoveryTaskFor(job);
  if (task.type !== state.type) {
    return panic(
      "Recovery scan cursor state does not match its scheduler task",
      { jobId: job.id },
    );
  }
  const leaseToken = job.lockedBy;
  if (leaseToken === null) {
    return panic("Recovery scan cursor checkpoint requires a scheduler lease");
  }
  return await withAggregateTransaction(database, async (tx) => {
    await setSharedStatementTimeout(tx, statementTimeoutMs);
    return await checkpointRecoverySchedulerJob({
      db: tx,
      task: task.task,
      jobId: job.id,
      leaseToken,
      scan: state.value,
    });
  });
};

export type RecoveryScanState =
  | { type: "upload"; value: UploadRecoveryState }
  | { type: "scout"; value: ScoutRecoveryState };

export type RecoveryScanContext = {
  database: SchedulerDb;
  job: Pick<SchedulerJob, "id" | "task" | "lockedBy">;
  scheduleContinuation: (nextRunAt: Date) => void;
};
