import { jsonb, p, sql } from "./common";

/** Transaction completion proofs; scoped application sessions cannot forge them. */
export const matterStewardshipLocks = p.pgTable.withRLS(
  "matter_stewardship_locks",
  {
    transactionId: p.bigint("transaction_id", { mode: "bigint" }).primaryKey(),
    proof: jsonb()
      .$type<{
        mode: "share" | "update";
        workspaces: readonly string[];
        members: readonly string[];
      }>()
      .notNull(),
  },
  () => [
    p.pgPolicy("matter_stewardship_lock_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.matter_stewardship_locks'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.matter_stewardship_locks'::regclass)`,
    }),
  ],
);
