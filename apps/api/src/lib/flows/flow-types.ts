import * as v from "valibot";

/**
 * Shared types and boundary schemas for the Workflows feature.
 *
 * Product name is "Workflows"; ALL internal code uses `flow` to avoid
 * colliding with the extraction engine in `apps/api/src/lib/workflow/`.
 *
 * A flow definition is a saved, reusable recipe: a LINEAR sequence of
 * typed steps executed against input documents. Definitions are
 * org-scoped templates; runs and their steps are workspace-scoped
 * execution records. All internal states are discriminated unions with
 * a stable discriminator (`kind` / `type` / `status`); no TS enums.
 */

// -- Domain constants --

/** Upper bound on steps per definition (also enforced in valibot). */
export const MAX_FLOW_STEPS = 20;

/**
 * Spend guard: max schedule/file-upload (automated) runs a single
 * definition may spawn per calendar day. Manual runs are not counted.
 */
export const MAX_AUTOMATED_FLOW_RUNS_PER_DEFINITION_PER_DAY = 20;

/**
 * Per prior-step-output char cap when assembling AI step context, so a
 * long upstream markdown output cannot blow the model context window.
 */
export const FLOW_STEP_OUTPUT_CONTEXT_CHAR_CAP = 20_000;

/** Per input-document char cap when an AI step includes documents. */
export const FLOW_DOCUMENT_CONTEXT_CHAR_CAP = 60_000;

// -- Step kinds --

export const FLOW_STEP_KINDS = [
  "ai",
  "review-gate",
  "create-document",
] as const;
export type FlowStepKind = (typeof FLOW_STEP_KINDS)[number];

/**
 * One node in a definition's linear step list. `ai` runs a single
 * non-streaming text generation; `review-gate` pauses the run for a
 * human decision; `create-document` renders the most recent `ai`
 * markdown into a workspace document entity.
 */
export type FlowStep =
  | { kind: "ai"; name: string; prompt: string; includeDocuments: boolean }
  | { kind: "review-gate"; name: string; instructions: string }
  | { kind: "create-document"; name: string; documentTitle: string };

// -- Schedule frequency --

export const FLOW_SCHEDULE_FREQUENCIES = [
  "daily",
  "weekly",
  "monthly",
] as const;
export type FlowScheduleFrequency = (typeof FLOW_SCHEDULE_FREQUENCIES)[number];

/**
 * How a definition is kicked off. `manual` = start-run endpoint only;
 * `schedule` = a single workspace on a recurring clock (times are UTC);
 * `file-upload` = fires when a matching user upload completes
 * (`workspaceIds`/`fileExtensions` `null` mean "any").
 */
export type FlowTrigger =
  | { type: "manual" }
  | {
      type: "schedule";
      workspaceId: string;
      schedule: {
        frequency: FlowScheduleFrequency;
        hourUtc: number;
        // `| undefined` matches the valibot/TypeBox boundary output under
        // exactOptionalPropertyTypes, so a parsed definition is assignable to
        // this column type without a cast.
        dayOfWeek?: number | undefined;
        dayOfMonth?: number | undefined;
      };
    }
  | {
      type: "file-upload";
      workspaceIds: string[] | null;
      fileExtensions: string[] | null;
    };

/** What actually initiated a given run (recorded on the run row). */
export type FlowTriggerSource =
  | { type: "manual"; userId: string }
  | { type: "schedule" }
  | { type: "file-upload"; entityId: string };

// -- Review decisions --

export const FLOW_REVIEW_DECISIONS = ["approved", "rejected"] as const;
export type FlowReviewDecision = (typeof FLOW_REVIEW_DECISIONS)[number];

/** Per-step result, stored on the step row once it completes. */
export type FlowStepOutput =
  | { kind: "ai"; markdown: string }
  | {
      kind: "review-gate";
      decision: FlowReviewDecision;
      userId: string;
      note: string | null;
    }
  | { kind: "create-document"; entityId: string };

/**
 * Frozen copy of the definition taken when a run starts. In-flight runs
 * read only this snapshot, never the live definition, so editing a
 * definition never mutates a run already in progress.
 */
export type FlowDefinitionSnapshot = {
  name: string;
  steps: FlowStep[];
};

// -- Run / step status value unions --

export const FLOW_RUN_STATUSES = [
  "pending",
  "running",
  "awaiting_review",
  "completed",
  "failed",
  "cancelled",
] as const;
export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number];

export const FLOW_RUN_STEP_STATUSES = [
  "pending",
  "running",
  "awaiting_review",
  "completed",
  "failed",
  "skipped",
] as const;
export type FlowRunStepStatus = (typeof FLOW_RUN_STEP_STATUSES)[number];

// -- Boundary schemas (definition input validation) --

const flowStepNameSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(200),
);

const aiFlowStepSchema = v.strictObject({
  kind: v.literal("ai"),
  name: flowStepNameSchema,
  prompt: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(10_000)),
  includeDocuments: v.boolean(),
});

const reviewGateFlowStepSchema = v.strictObject({
  kind: v.literal("review-gate"),
  name: flowStepNameSchema,
  instructions: v.pipe(v.string(), v.trim(), v.maxLength(10_000)),
});

const createDocumentFlowStepSchema = v.strictObject({
  kind: v.literal("create-document"),
  name: flowStepNameSchema,
  documentTitle: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256)),
});

export const flowStepSchema = v.variant("kind", [
  aiFlowStepSchema,
  reviewGateFlowStepSchema,
  createDocumentFlowStepSchema,
]);

const hourUtcSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(23),
);
const dayOfWeekSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(6),
);
const dayOfMonthSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(28),
);

const flowScheduleSchema = v.strictObject({
  frequency: v.picklist(FLOW_SCHEDULE_FREQUENCIES),
  hourUtc: hourUtcSchema,
  dayOfWeek: v.optional(dayOfWeekSchema),
  dayOfMonth: v.optional(dayOfMonthSchema),
});

const fileExtensionSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(32));

export const flowTriggerSchema = v.variant("type", [
  v.strictObject({ type: v.literal("manual") }),
  v.strictObject({
    type: v.literal("schedule"),
    workspaceId: v.pipe(v.string(), v.uuid()),
    schedule: flowScheduleSchema,
  }),
  v.strictObject({
    type: v.literal("file-upload"),
    workspaceIds: v.nullable(v.array(v.pipe(v.string(), v.uuid()))),
    fileExtensions: v.nullable(v.array(fileExtensionSchema)),
  }),
]);

/**
 * Boundary schema for creating/updating a definition. Enforces the
 * 1..MAX_FLOW_STEPS bound, non-empty step names, and trigger shape.
 * The org-ownership check for a `schedule` trigger's `workspaceId` is
 * server-side (it needs a DB read) and is NOT expressed here.
 */
export const flowDefinitionInputSchema = v.strictObject({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256)),
  description: v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(2_000))),
  steps: v.pipe(
    v.array(flowStepSchema),
    v.minLength(1),
    v.maxLength(MAX_FLOW_STEPS),
  ),
  trigger: flowTriggerSchema,
  enabled: v.boolean(),
});

export type FlowDefinitionInput = v.InferOutput<
  typeof flowDefinitionInputSchema
>;
