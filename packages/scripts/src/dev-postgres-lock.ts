import type { ReservedSQL } from "bun";

/** Owns the session lock for cluster-wide local test provisioning. */
export const withSharedPostgresLock = async <T>(
  connection: ReservedSQL,
  work: () => Promise<T>,
) => {
  await connection`SELECT pg_advisory_lock(5711, 15432)`;
  try {
    return await work();
  } finally {
    await connection`SELECT pg_advisory_unlock(5711, 15432)`;
  }
};
