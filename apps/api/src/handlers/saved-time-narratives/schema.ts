import { t } from "elysia";

import { tSafeId } from "@/api/lib/custom-schema";

export const savedTimeNarrativeParamsSchema = t.Object({
  id: tSafeId("savedTimeNarrative"),
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
