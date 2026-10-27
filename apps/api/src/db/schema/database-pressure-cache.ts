import type { HostPressureSnapshot } from "@/api/lib/db/pressure-reader";

import { p, sql, timestamptz } from "./common";

/** Fleet-wide refresh admission and last real host pressure observation. */
export const databasePressureCache = p.pgTable(
  "database_pressure_cache",
  {
    instanceIdentifier: p.text("instance_identifier").primaryKey(),
    refreshToken: p.text("refresh_token"),
    nextRefreshAt: timestamptz("next_refresh_at").notNull(),
    snapshot: p.jsonb().$type<HostPressureSnapshot>(),
  },
  () => [
    p.pgPolicy("database_pressure_cache_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.database_pressure_cache'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.database_pressure_cache'::regclass)`,
    }),
  ],
);
