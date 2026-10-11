import { denyStellaAccessPolicies } from "@/api/db/rls";

import { p, sql, timestamptz } from "./common";

const ownerAccess = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.desktop_device_proof_replays'::regclass)`;

/** Short-lived device proof receipts, readable only through the table owner. */
export const desktopDeviceProofReplays = p.pgTable.withRLS(
  "desktop_device_proof_replays",
  {
    jkt: p.text().notNull(),
    jti: p.text().notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({
      name: "desktop_device_proof_replays_pkey",
      columns: [table.jkt, table.jti],
    }),
    p.index("desktop_device_proof_replays_expiry_idx").on(table.expiresAt),
    p.pgPolicy("desktop_device_proof_replays_owner_access", {
      for: "all",
      to: "public",
      using: ownerAccess,
      withCheck: ownerAccess,
    }),
    ...denyStellaAccessPolicies(),
  ],
);
