import { p, sql, stella, timestamptz } from "./common";

export const ONLINE_WORK_STATES = ["building", "finalized", "failed"] as const;

/** Progress of pending online work, written only by the post-deploy runner. */
export const onlineWorkState = p.pgTable(
  "online_work_state",
  {
    name: p.text().primaryKey(),
    state: p.text({ enum: ONLINE_WORK_STATES }).notNull(),
    attempts: p.integer().notNull().default(0),
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
    p.pgPolicy("online_work_state_no_stella_access", {
      for: "all",
      to: stella,
      using: sql`false`,
      withCheck: sql`false`,
    }),
  ],
);
