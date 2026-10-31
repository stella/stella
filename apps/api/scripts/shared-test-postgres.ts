import { runSharedTestPostgres } from "../../../packages/scripts/src/shared-test-postgres";
import { createSqlClient } from "../src/db/sql-client";

if (import.meta.main) {
  await runSharedTestPostgres(async (url, work) => {
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
  });
}
