import { t } from "elysia";

import {
  playbookPositionsSchema,
  playbookScopeSchema,
} from "@/api/handlers/playbooks/positions";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";

export const playbookDefinitionBodySchema = t.Object({
  name: tDefaultVarchar,
  description: t.Optional(t.String({ maxLength: 2000 })),
  scope: t.Optional(playbookScopeSchema),
  positions: playbookPositionsSchema,
});

export const playbookDefinitionParamsSchema = t.Object({
  playbookId: tSafeId("playbookDefinition"),
});
