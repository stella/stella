import { t } from "elysia";

import {
  tDefaultVarchar,
  tSafeId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import {
  FLOW_REVIEW_DECISIONS,
  FLOW_RUN_STATUSES,
  FLOW_SCHEDULE_FREQUENCIES,
  MAX_FLOW_STEPS,
} from "@/api/lib/flows/flow-types";
import { LIMITS } from "@/api/lib/limits";

// The HTTP contract for a flow definition (Eden-typed shape + first-pass
// validation). The handler additionally parses the body through the shared
// valibot `flowDefinitionInputSchema` to normalize (trim) and enforce the
// deeper invariants in one authoritative place.

const tStepName = t.String({ minLength: 1, maxLength: 200 });

const tFlowStep = t.Union([
  t.Object({
    kind: t.Literal("ai"),
    name: tStepName,
    prompt: t.String({ minLength: 1, maxLength: 10_000 }),
    includeDocuments: t.Boolean(),
  }),
  t.Object({
    kind: t.Literal("review-gate"),
    name: tStepName,
    instructions: t.String({ maxLength: 10_000 }),
  }),
  t.Object({
    kind: t.Literal("create-document"),
    name: tStepName,
    documentTitle: t.String({ minLength: 1, maxLength: 256 }),
  }),
]);

const tFlowSchedule = t.Object({
  // `t.Union(arr.map(t.Literal))` builds the union from a general array, whose
  // static type Eden cannot reconstruct — it collapses to `never` on the client
  // body type. Use `t.UnionEnum([...const])` like the required `decision` field
  // below so the frontend sees `"daily" | "weekly" | "monthly"`.
  frequency: t.UnionEnum([...FLOW_SCHEDULE_FREQUENCIES]),
  hourUtc: t.Integer({ minimum: 0, maximum: 23 }),
  dayOfWeek: t.Optional(t.Integer({ minimum: 0, maximum: 6 })),
  dayOfMonth: t.Optional(t.Integer({ minimum: 1, maximum: 28 })),
});

const tFlowTrigger = t.Union([
  t.Object({ type: t.Literal("manual") }),
  t.Object({
    type: t.Literal("schedule"),
    workspaceId: tSafeId("workspace"),
    schedule: tFlowSchedule,
  }),
  t.Object({
    type: t.Literal("file-upload"),
    workspaceIds: t.Union([t.Array(tSafeId("workspace")), t.Null()]),
    fileExtensions: t.Union([
      t.Array(t.String({ minLength: 1, maxLength: 32 })),
      t.Null(),
    ]),
  }),
]);

export const flowDefinitionBodySchema = t.Object({
  name: tDefaultVarchar,
  description: t.Union([t.String({ maxLength: 2000 }), t.Null()]),
  steps: t.Array(tFlowStep, { minItems: 1, maxItems: MAX_FLOW_STEPS }),
  trigger: tFlowTrigger,
  enabled: t.Boolean(),
});

export const flowDefinitionParamsSchema = t.Object({
  flowId: tSafeId("flowDefinition"),
});

export const listFlowDefinitionsQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.flowDefinitionsPageSizeMax }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});

// -- Runs (workspace-scoped) --

export const flowRunsWorkspaceParamsSchema = workspaceParams({});

export const flowRunParamsSchema = workspaceParams({
  runId: tSafeId("flowRun"),
});

export const listFlowRunsQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.flowRunsPageSizeMax }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
  status: t.Optional(t.Union(FLOW_RUN_STATUSES.map((s) => t.Literal(s)))),
});

export const startFlowRunBodySchema = t.Object({
  definitionId: tSafeId("flowDefinition"),
  inputEntityIds: t.Array(tSafeId("entity"), {
    maxItems: LIMITS.flowRunInputEntitiesMax,
  }),
});

export const reviewFlowRunBodySchema = t.Object({
  // Required enum fields use t.UnionEnum (matches invoices/transition.ts):
  // the mapped-literal t.Union form collapses to `never` on the Eden client
  // once the invalidateQuery macro's body schema is merged into this route.
  // The optional-UnionEnum coercion gotcha does not apply to required fields.
  decision: t.UnionEnum([...FLOW_REVIEW_DECISIONS]),
  note: t.Optional(t.Union([t.String({ maxLength: 2000 }), t.Null()])),
});
