import { Result } from "better-result";
import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";

/**
 * Read-only, instance-wide access boundary for operator observability
 * reads. The Better Auth `user` table is instance infrastructure with no
 * workspace/organization scoping, so these reads go through the
 * owner-level handle; the wrapper pins the transaction read-only so this
 * surface structurally cannot write, and handlers never touch `rootDb`
 * directly.
 */
export const operatorReadDb: SafeDb = async (fn) =>
  await Result.tryPromise(
    async () =>
      await rootDb.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);

        return await fn(tx);
      }),
  );
