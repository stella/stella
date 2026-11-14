import * as v from "valibot";

import { resourceIdSchema } from "@/api/lib/custom-schema";

export const savedTimeNarrativeParamsSchema = v.object({
  id: resourceIdSchema("savedTimeNarrative"),
});

export const toSavedTimeNarrativeItem = (row: {
  id: string;
  name: string;
  narrative: string;
  narrativeLanguage: string | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: row.id,
  name: row.name,
  narrative: row.narrative,
  narrativeLanguage: row.narrativeLanguage,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
