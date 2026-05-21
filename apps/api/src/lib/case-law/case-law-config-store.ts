import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { caseLawCourtWeights, caseLawFtsConfigs } from "@/api/db/schema";

type CourtWeightRow = typeof caseLawCourtWeights.$inferInsert;
type FtsConfigRow = typeof caseLawFtsConfigs.$inferInsert;

export const readCourtWeightRows = async () =>
  await rootDb.select().from(caseLawCourtWeights);

export const readFtsConfigRows = async () =>
  await rootDb.select().from(caseLawFtsConfigs);

export const upsertCourtWeightRows = async (rows: CourtWeightRow[]) =>
  await rootDb
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
  await rootDb
    .insert(caseLawFtsConfigs)
    .values(rows)
    .onConflictDoUpdate({
      target: [caseLawFtsConfigs.language],
      set: {
        regconfig: sql`excluded.regconfig`,
        useUnaccent: sql`excluded.use_unaccent`,
      },
    });
