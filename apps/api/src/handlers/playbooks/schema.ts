import * as v from "valibot";

import {
  defaultVarcharSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { expectedUpdatedAtSchema } from "@/api/lib/optimistic-concurrency";
import {
  playbookPositionsSchema,
  playbookScopeSchema,
} from "@/api/lib/workflow/playbook-positions";

const playbookDefinitionFields = {
  name: defaultVarcharSchema,
  description: v.exactOptional(v.pipe(v.string(), v.maxLength(2000))),
  scope: v.exactOptional(playbookScopeSchema),
  positions: playbookPositionsSchema,
};

export const playbookDefinitionBodySchema = v.object(playbookDefinitionFields);

/**
 * Create's body plus the concurrency token. `expectedUpdatedAt` is optional
 * so scripted callers (MCP, CLI) that never loaded the definition in an
 * editor keep working; the editor always sends it and so gets the
 * stale-overwrite guard. Drop the optionality once every writer is an editor
 * round-trip.
 */
export const updatePlaybookDefinitionBodySchema = v.object({
  ...playbookDefinitionFields,
  expectedUpdatedAt: v.exactOptional(expectedUpdatedAtSchema),
});

export const approvePlaybookDefinitionBodySchema = v.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

export const playbookDefinitionParamsSchema = v.object({
  playbookId: resourceIdSchema("playbookDefinition"),
});
