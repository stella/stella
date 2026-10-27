import { p, sql, timestamptz } from "./common";

export const ONLINE_WORK_STATES = [
  "pending",
  "running",
  "paused",
  "done",
  "failed",
] as const;

/** Remove with the foundation rollout adapter after old tasks are gone. */
export const ONLINE_WORK_LEGACY_STATES = {
  building: "running",
  finalized: "done",
} as const satisfies Record<string, (typeof ONLINE_WORK_STATES)[number]>;

/** Durable progress and operator pauses for registered online work. */
export const onlineWorkState = p.pgTable(
  "online_work_state",
  {
    name: p.text().primaryKey(),
    state: p.text({ enum: ONLINE_WORK_STATES }).notNull(),
    attempts: p.integer().notNull().default(0),
    pausedBy: p.text("paused_by"),
    pausedSince: timestamptz("paused_since"),
    pausedUntil: timestamptz("paused_until"),
    pauseReason: p.text("pause_reason"),
    lastError: p.text("last_error"),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.check(
      "online_work_state_state_check",
      sql`${table.state} IN (${sql.join(
        ONLINE_WORK_STATES.map((state) => sql`${state}`),
        sql`, `,
      )})`,
    ),
    p.check(
      "online_work_state_pause_check",
      sql`${table.pausedUntil} IS NULL OR (isfinite(${table.pausedUntil}) AND ${table.pausedBy} IS NOT NULL AND length(btrim(${table.pausedBy})) > 0 AND ${table.pauseReason} IS NOT NULL AND length(btrim(${table.pauseReason})) >= 8)`,
    ),
    p.pgPolicy("online_work_state_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.online_work_state'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.online_work_state'::regclass)`,
    }),
  ],
);
