import { t } from "elysia";

import { playbookPositionsSchema } from "@/api/handlers/playbooks/positions";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";

export const playbookDefinitionBodySchema = t.Object({
  name: tDefaultVarchar,
  description: t.Optional(t.String({ maxLength: 2000 })),
  positions: playbookPositionsSchema,
});

export const playbookDefinitionParamsSchema = t.Object({
  playbookId: tSafeId("playbookDefinition"),
});
