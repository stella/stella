import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import {
  paginationCursorSchema,
  resourceIdSchema,
  workspaceParams,
} from "@/api/lib/custom-schema";
import {
  FLOW_DEFINITION_DESCRIPTION_MAX_CHARS,
  FLOW_DEFINITION_NAME_MAX_CHARS,
  FLOW_REVIEW_DECISIONS,
  FLOW_SCHEDULE_FREQUENCIES,
  FLOW_STEP_DOCUMENT_TITLE_MAX_CHARS,
  FLOW_STEP_INSTRUCTION_CHAR_CAP,
  FLOW_STEP_NAME_MAX_CHARS,
  MAX_FLOW_STEPS,
} from "@/api/lib/flows/flow-types";
import type { FLOW_RUN_STATUSES } from "@/api/lib/flows/flow-types";
import { LIMITS } from "@/api/lib/limits";

// The HTTP contract for a flow definition (the API client's typed shape +
// first-pass validation). The handler additionally parses the body through
// the shared valibot `flowDefinitionInputSchema` to normalize (trim) and
// enforce the deeper invariants in one authoritative place.
//
// The two layers describe the same body, so every scalar bound here comes from
// the constants `flow-types.ts` exports rather than a literal restated per
// layer; only the shapes the two layers express differently are written
// twice.

const tStepName = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(FLOW_STEP_NAME_MAX_CHARS),
);

const tFlowStep = v.union([
  v.object({
    kind: v.literal("ai"),
    name: tStepName,
    prompt: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(FLOW_STEP_INSTRUCTION_CHAR_CAP),
    ),
    includeDocuments: v.boolean(),
  }),
  v.object({
    kind: v.literal("review-gate"),
    name: tStepName,
    instructions: v.pipe(
      v.string(),
      v.maxLength(FLOW_STEP_INSTRUCTION_CHAR_CAP),
    ),
  }),
  v.object({
    kind: v.literal("create-document"),
    name: tStepName,
    documentTitle: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(FLOW_STEP_DOCUMENT_TITLE_MAX_CHARS),
    ),
  }),
]);

const tFlowSchedule = v.object({
  frequency: v.picklist([...FLOW_SCHEDULE_FREQUENCIES]),
  hourUtc: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(23)),
  dayOfWeek: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6)),
  ),
  dayOfMonth: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(28)),
  ),
});

const tFlowTrigger = v.union([
  v.object({ type: v.literal("manual") }),
  v.object({
    type: v.literal("schedule"),
    workspaceId: resourceIdSchema("workspace"),
    schedule: tFlowSchedule,
  }),
  v.object({
    type: v.literal("file-upload"),
    workspaceIds: v.union([v.array(resourceIdSchema("workspace")), v.null()]),
    fileExtensions: v.union([
      v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(32))),
      v.null(),
    ]),
  }),
]);

export const flowDefinitionBodySchema = v.object({
  name: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(FLOW_DEFINITION_NAME_MAX_CHARS),
  ),
  description: v.union([
    v.pipe(v.string(), v.maxLength(FLOW_DEFINITION_DESCRIPTION_MAX_CHARS)),
    v.null(),
  ]),
  steps: v.pipe(
    v.array(tFlowStep),
    v.minLength(1),
    v.maxLength(MAX_FLOW_STEPS),
  ),
  trigger: tFlowTrigger,
  enabled: v.boolean(),
});

export const flowDefinitionParamsSchema = v.object({
  flowId: resourceIdSchema("flowDefinition"),
});

export const listFlowDefinitionsQuerySchema = v.object({
  limit: v.exactOptional(
    numberFromString(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(LIMITS.flowDefinitionsPageSizeMax),
      ),
    ),
  ),
  cursor: v.exactOptional(paginationCursorSchema()),
});

// -- Runs (workspace-scoped) --

export const flowRunsWorkspaceParamsSchema = workspaceParams({});

export const flowRunParamsSchema = workspaceParams({
  runId: resourceIdSchema("flowRun"),
});

export const listFlowRunsQuerySchema = v.object({
  limit: v.exactOptional(
    numberFromString(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(LIMITS.flowRunsPageSizeMax),
      ),
    ),
  ),
  cursor: v.exactOptional(paginationCursorSchema()),
  status: v.exactOptional(
    v.picklist([
      "pending",
      "running",
      "awaiting_review",
      "completed",
      "failed",
      "cancelled",
    ]),
  ),
});

// The literal list mirrors FLOW_RUN_STATUSES: a member on one side only fails
// to compile here.
type FlowRunStatusValue = (typeof FLOW_RUN_STATUSES)[number];
type FlowRunStatusQueryValue = NonNullable<
  v.InferOutput<typeof listFlowRunsQuerySchema>["status"]
>;
type MissingFlowRunStatusQueryValue = Exclude<
  FlowRunStatusValue,
  FlowRunStatusQueryValue
>;
type UnexpectedFlowRunStatusQueryValue = Exclude<
  FlowRunStatusQueryValue,
  FlowRunStatusValue
>;

true satisfies MissingFlowRunStatusQueryValue extends never ? true : never;
true satisfies UnexpectedFlowRunStatusQueryValue extends never ? true : never;

export const startFlowRunBodySchema = v.object({
  definitionId: resourceIdSchema("flowDefinition"),
  inputEntityIds: v.pipe(
    v.array(resourceIdSchema("entity")),
    v.maxLength(LIMITS.flowRunInputEntitiesMax),
  ),
  confirmedUnits: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

export const reviewFlowRunBodySchema = v.object({
  decision: v.picklist([...FLOW_REVIEW_DECISIONS]),
  note: v.optional(v.union([v.pipe(v.string(), v.maxLength(2000)), v.null()])),
});
