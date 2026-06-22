import { t } from "elysia";

import { playbookBundleColumnSchema } from "@/api/db/schema-validators";
import { tSafeId } from "@/api/lib/custom-schema";

export const playbookBodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 256 }),
  typePropertyId: tSafeId("property"),
  typeValue: t.String({ minLength: 1, maxLength: 1000 }),
  bundle: t.Array(playbookBundleColumnSchema, { minItems: 1, maxItems: 100 }),
});

export const playbookParamsSchema = t.Object({
  playbookId: tSafeId("playbook"),
});
