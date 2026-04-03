import { sql } from "drizzle-orm";

import { db } from "@/api/db/root";
import { caseLawCourtWeights, caseLawFtsConfigs } from "@/api/db/schema";

type CourtWeightRow = typeof caseLawCourtWeights.$inferInsert;
type FtsConfigRow = typeof caseLawFtsConfigs.$inferInsert;

export const readCourtWeightRows = async () =>
  await db.select().from(caseLawCourtWeights);

export const readFtsConfigRows = async () =>
  await db.select().from(caseLawFtsConfigs);

export const upsertCourtWeightRows = async (rows: CourtWeightRow[]) =>
  await db
    .insert(caseLawCourtWeights)
    .values(rows)
    .onConflictDoUpdate({
      target: [caseLawCourtWeights.country, caseLawCourtWeights.courtPattern],
      set: {
        tier: sql`excluded.tier`,
        tierLabel: sql`excluded.tier_label`,
        weight: sql`excluded.weight`,
      },
    });

export const upsertFtsConfigRows = async (rows: FtsConfigRow[]) =>
  await db
    .insert(caseLawFtsConfigs)
    .values(rows)
    .onConflictDoUpdate({
      target: [caseLawFtsConfigs.language],
      set: {
        regconfig: sql`excluded.regconfig`,
        useUnaccent: sql`excluded.use_unaccent`,
      },
    });
