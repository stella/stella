import { sql } from "drizzle-orm";

import { db } from "@/api/db/root";

const main = async () => {
  const [tableInfo] = await db.execute(sql`
    SELECT to_regclass('public.workspaces') AS name
  `);

  if (tableInfo?.name === null) {
    return;
  }

  const [result] = await db.execute(sql`
    SELECT COUNT(*)::int AS total
    FROM workspaces
    WHERE client_id IS NULL
  `);

  const orphanedWorkspaceCount = Number(result?.total ?? 0);
  if (orphanedWorkspaceCount === 0) {
    return;
  }

  throw new Error(
    `Refusing to run db:push: found ${orphanedWorkspaceCount} workspace(s) with NULL client_id. Reset the database or backfill clients before applying the client-first matter schema.`,
  );
};

await main();
