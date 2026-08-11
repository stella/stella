import { t } from "elysia";

import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import {
  playbookPositionsSchema,
  playbookScopeSchema,
} from "@/api/lib/workflow/playbook-positions";

export const playbookDefinitionBodySchema = t.Object({
  name: tDefaultVarchar,
  description: t.Optional(t.String({ maxLength: 2000 })),
  scope: t.Optional(playbookScopeSchema),
  positions: playbookPositionsSchema,
});

export const approvePlaybookDefinitionBodySchema = t.Object({
  expectedUpdatedAt: t.String({ format: "date-time" }),
});

export const playbookDefinitionParamsSchema = t.Object({
  playbookId: tSafeId("playbookDefinition"),
});
