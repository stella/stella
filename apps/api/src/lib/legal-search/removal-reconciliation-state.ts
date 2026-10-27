import * as v from "valibot";

import {
  REMOVAL_SUPERSEDED_REASON,
  removalEvidenceSchema,
} from "./removal-evidence";

const uuid = v.pipe(v.string(), v.uuid());

const activeRemovalCheckpointSchema = v.variant("status", [
  v.strictObject({
    status: v.literal("running"),
    cursor: v.nullable(uuid),
    ceiling: uuid,
  }),
  v.strictObject({
    status: v.literal("waiting"),
    nextCycleAt: v.pipe(v.string(), v.isoTimestamp()),
  }),
]);

export const removalCheckpointSchema = v.variant("status", [
  ...activeRemovalCheckpointSchema.options,
  v.strictObject({
    status: v.literal("paused"),
    resume: v.nullable(activeRemovalCheckpointSchema),
    resumeAt: v.pipe(v.string(), v.isoTimestamp()),
  }),
]);

export type RemovalCheckpoint = v.InferOutput<typeof removalCheckpointSchema>;

export const REMOVAL_RETRY_KIND = {
  ERASURE: "removal-erasure",
  PENDING: "removal-pending",
  UNPROBEABLE: "removal-unprobeable",
} as const;
export const REMOVAL_RETRY_KINDS = Object.values(REMOVAL_RETRY_KIND);

export const REMOVAL_UNPROBEABLE_REASON = {
  MISSING_IDENTITY: "missing-source-document-id",
  INVALID_IDENTITY: "invalid-source-document-id",
} as const;
export const REMOVAL_PENDING_REASON = {
  PUBLISHER_ABSENT: "publisher-absent",
  PUBLISHER_UNAVAILABLE: "publisher-unavailable",
  PUBLISHER_REFUSED: "publisher-refused",
  STORES_PENDING: "stores-pending",
  OPERATION_FAILED: "operation-failed",
} as const;

export const removalRetryPayloadSchema = v.union([
  v.strictObject({
    type: v.literal("superseded"),
    decisionId: uuid,
    previousItemId: uuid,
    evidence: removalEvidenceSchema,
    reason: v.picklist(Object.values(REMOVAL_SUPERSEDED_REASON)),
  }),
  v.strictObject({
    type: v.literal("unprobeable"),
    decisionId: uuid,
    reason: v.picklist(Object.values(REMOVAL_UNPROBEABLE_REASON)),
  }),
  v.strictObject({
    type: v.literal("pending"),
    operation: v.literal("probe"),
    decisionId: uuid,
    reason: v.picklist([
      REMOVAL_PENDING_REASON.PUBLISHER_UNAVAILABLE,
      REMOVAL_PENDING_REASON.PUBLISHER_REFUSED,
      REMOVAL_PENDING_REASON.OPERATION_FAILED,
    ]),
  }),
  v.strictObject({
    type: v.literal("pending"),
    operation: v.literal("erase"),
    evidence: removalEvidenceSchema,
    decisionId: uuid,
    reason: v.picklist([
      REMOVAL_PENDING_REASON.PUBLISHER_ABSENT,
      REMOVAL_PENDING_REASON.STORES_PENDING,
      REMOVAL_PENDING_REASON.OPERATION_FAILED,
    ]),
  }),
]);
export type RemovalRetryPayload = v.InferOutput<
  typeof removalRetryPayloadSchema
>;
export type UnprobeableRemovalRead = Omit<
  Extract<RemovalRetryPayload, { type: "unprobeable" }>,
  "decisionId"
>;
export type RemovalStepOutcome =
  | { type: "settled" }
  | Omit<
      Extract<RemovalRetryPayload, { type: "pending"; operation: "probe" }>,
      "decisionId"
    >
  | Omit<
      Extract<RemovalRetryPayload, { type: "pending"; operation: "erase" }>,
      "decisionId"
    >
  | UnprobeableRemovalRead
  | Omit<
      Extract<RemovalRetryPayload, { type: "superseded" }>,
      "decisionId" | "previousItemId"
    >;

const NON_PENDING_RETRY_KIND = {
  superseded: REMOVAL_RETRY_KIND.PENDING,
  unprobeable: REMOVAL_RETRY_KIND.UNPROBEABLE,
} as const satisfies Record<
  Exclude<RemovalRetryPayload["type"], "pending">,
  (typeof REMOVAL_RETRY_KINDS)[number]
>;
const PENDING_RETRY_KIND = {
  erase: REMOVAL_RETRY_KIND.ERASURE,
  probe: REMOVAL_RETRY_KIND.PENDING,
} as const satisfies Record<
  Extract<RemovalRetryPayload, { type: "pending" }>["operation"],
  (typeof REMOVAL_RETRY_KINDS)[number]
>;
export const removalRetryKind = (
  payload:
    Exclude<RemovalStepOutcome, { type: "settled" }> | RemovalRetryPayload,
) =>
  payload.type === "pending"
    ? PENDING_RETRY_KIND[payload.operation]
    : NON_PENDING_RETRY_KIND[payload.type];
