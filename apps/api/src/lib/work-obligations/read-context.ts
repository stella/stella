import { sql } from "drizzle-orm";

import type { EntityContextReference } from "@stll/api-contract/entity-reference";

import { entityContextProjection } from "@/api/db/entity-feature-policies";
import type { workObligationEvents } from "@/api/db/schema";
import { workObligations } from "@/api/db/schema";

type WorkObligationEventDetails =
  typeof workObligationEvents.$inferSelect.details;

type WorkObligationReadEventDetails =
  | Exclude<WorkObligationEventDetails, { type: "provenance_changed" }>
  | (Extract<WorkObligationEventDetails, { type: "provenance_changed" }> & {
      previousSourceReference: EntityContextReference;
      nextSourceReference: EntityContextReference;
    });

const sourceContext = entityContextProjection(workObligations.sourceEntityId);

export const WORK_OBLIGATION_CONTEXT_EXTRAS = {
  sourceEntityId: (table: typeof workObligations) =>
    sourceContext.id(table.sourceEntityId),
  sourceReference: (table: typeof workObligations) =>
    sourceContext.reference(table.sourceEntityId),
};

/** Read projections preserve immutable history and redact unavailable source handles. */
export const WORK_OBLIGATION_EVENT_CONTEXT_EXTRAS = {
  details: (table: typeof workObligationEvents) => {
    const previous = sql`(${table.details}->>'previousSourceEntityId')::uuid`;
    const next = sql`(${table.details}->>'nextSourceEntityId')::uuid`;
    return sql<WorkObligationReadEventDetails>`CASE WHEN ${table.details}->>'type' = 'provenance_changed'
      THEN ${table.details} || jsonb_build_object(
        'previousSourceEntityId', ${sourceContext.id(previous)},
        'nextSourceEntityId', ${sourceContext.id(next)},
        'previousSourceReference', ${sourceContext.reference(previous)},
        'nextSourceReference', ${sourceContext.reference(next)})
      ELSE ${table.details} END`;
  },
};
