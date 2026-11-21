import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

// A missing settings row means enabled. Row locks alone cannot fence insertion
// of the first disabled row against a concurrent monitoring commit.
export const lockSanctionsMonitoring = async (
  tx: Pick<Transaction, "execute">,
  organizationId: SafeId<"organization">,
) =>
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext('sanctions-monitoring'))`,
  );
