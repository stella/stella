import { t } from "elysia";

import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { expectedUpdatedAtSchema } from "@/api/lib/optimistic-concurrency";
import {
  playbookPositionsSchema,
  playbookScopeSchema,
} from "@/api/lib/workflow/playbook-positions";

const playbookDefinitionFields = {
  name: tDefaultVarchar,
  description: t.Optional(t.String({ maxLength: 2000 })),
  scope: t.Optional(playbookScopeSchema),
  positions: playbookPositionsSchema,
};

export const playbookDefinitionBodySchema = t.Object(playbookDefinitionFields);

/**
 * Create's body plus the concurrency token. `expectedUpdatedAt` is optional
 * so scripted callers (MCP, CLI) that never loaded the definition in an
 * editor keep working; the editor always sends it and so gets the
 * stale-overwrite guard. Drop the optionality once every writer is an editor
 * round-trip.
 */
export const updatePlaybookDefinitionBodySchema = t.Object({
  ...playbookDefinitionFields,
  expectedUpdatedAt: t.Optional(expectedUpdatedAtSchema),
});

export const approvePlaybookDefinitionBodySchema = t.Object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

export const playbookDefinitionParamsSchema = t.Object({
  playbookId: tSafeId("playbookDefinition"),
});
