import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  HOSTED_CUSTOMER_ERASURE_STATUS,
  hostedCustomerErasures,
} from "@/api/db/schema";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

// The gated database runs the migrations as the production-shaped owner: no
// superuser, no RLS bypass (prod-parity.postgres.test.ts). Forced row security
// therefore applies to the owner too, so an erasure intent is written only
// through the table's owner-access policy.
describe.skipIf(!enabled)("hosted customer erasure intents (postgres)", () => {
  test("the owning API login records, reads and clears an intent under forced row security", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Hosted customer erasure test requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const externalCustomerRef = `cus_${Bun.randomUUIDv7()}`;

      const inserted = await db
        .insert(hostedCustomerErasures)
        .values({ externalCustomerRef })
        .returning({ status: hostedCustomerErasures.status });
      expect(inserted).toEqual([
        { status: HOSTED_CUSTOMER_ERASURE_STATUS.pending },
      ]);

      const stored = await db
        .select({ ref: hostedCustomerErasures.externalCustomerRef })
        .from(hostedCustomerErasures)
        .where(
          eq(hostedCustomerErasures.externalCustomerRef, externalCustomerRef),
        );
      expect(stored).toEqual([{ ref: externalCustomerRef }]);

      const removed = await db
        .delete(hostedCustomerErasures)
        .where(
          eq(hostedCustomerErasures.externalCustomerRef, externalCustomerRef),
        )
        .returning({ ref: hostedCustomerErasures.externalCustomerRef });
      expect(removed).toEqual([{ ref: externalCustomerRef }]);
    });
  });
});
