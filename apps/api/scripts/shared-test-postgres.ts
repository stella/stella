import type { ReservedSQL } from "bun";

import { runSharedTestPostgres } from "../../../packages/scripts/src/shared-test-postgres";
import { createSqlClient } from "../src/db/sql-client";

export const withSharedTestPostgresConnection = async <T>(
  url: string,
  work: (connection: ReservedSQL) => Promise<T>,
) => {
  const client = createSqlClient({ url, max: 1 });
  try {
    const connection = await client.reserve();
    try {
      return await work(connection);
    } finally {
      await connection.release();
    }
  } finally {
    await client.close();
  }
};

if (import.meta.main) {
  await runSharedTestPostgres(withSharedTestPostgresConnection);
}
