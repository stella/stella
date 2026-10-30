import { sql } from "drizzle-orm";

import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

export type RequestReceiptScenario = {
  type: "request-receipts";
  rows: number;
  cohort: "expired" | "quiet" | "mixed";
};

const ORGANIZATION_ID = toSafeId<"organization">(
  "01990000-00b0-7000-8000-000000000001",
);
const USER_ID = toSafeId<"user">("query-perf-receipt-owner");

/** Real receipt rows: a full drain, no eligible work, and sparse pending work. */
export const seedRequestReceiptScenario = async (
  database: GatedTestDb,
  { rows, cohort }: RequestReceiptScenario,
) => {
  await database.execute(sql`INSERT INTO organization (id, name, slug, created_at)
    VALUES (${ORGANIZATION_ID}, 'Receipt measurement', 'receipt-measurement', now())
    ON CONFLICT (id) DO NOTHING`);
  await database.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (${USER_ID}, 'Receipt measurement', 'receipt-measurement@example.test', true, now(), now())
    ON CONFLICT (id) DO NOTHING`);
  await database.execute(sql`TRUNCATE request_idempotency_receipts`);
  // Receipts are written as their owner, the only writer the table's policies admit.
  await createScopedDb(
    markRlsDatabase(database),
    [],
    ORGANIZATION_ID,
    USER_ID,
  )(async (tx) => {
    await tx.execute(sql`INSERT INTO request_idempotency_receipts
    (id, organization_id, user_id, idempotency_key, route, request_fingerprint,
     state, response_status, response_body, claimed_at, completed_at)
    SELECT md5('receipt-' || i)::uuid, ${ORGANIZATION_ID}, ${USER_ID}, 'receipt-' || i,
      '/query-perf/receipts', repeat('a', 64),
      CASE WHEN ${cohort} = 'mixed' AND i % 16 = 0 THEN 'pending' ELSE 'completed' END,
      CASE WHEN ${cohort} = 'mixed' AND i % 16 = 0 THEN NULL ELSE 200 END,
      jsonb_build_object('value', repeat(md5(i::text), 32)),
      CASE WHEN ${cohort} = 'expired' THEN '2026-01-01T12:00:00Z'::timestamptz
        ELSE '2026-01-10T11:00:00Z'::timestamptz END,
      CASE WHEN ${cohort} = 'mixed' AND i % 16 = 0 THEN NULL
        ELSE '2026-01-10T11:00:00Z'::timestamptz END
    FROM generate_series(1, ${rows}::integer) AS i`);
  });
  await database.execute(sql`VACUUM (ANALYZE) request_idempotency_receipts`);
};
