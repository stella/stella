import { Result } from "better-result";
import { sql } from "drizzle-orm";
import Elysia from "elysia";

import { db } from "@/api/db";

export const healthRoute = new Elysia().get("/health", async ({ set }) => {
  const probe = db.execute(sql`SELECT 1`);
  const timeout = new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error("DB probe timeout")), 5000);
  });
  const result = await Result.tryPromise(
    async () => await Promise.race([probe, timeout]),
  );

  if (result.isErr()) {
    set.status = 503;
    return {
      status: "error" as const,
      message: "Database unreachable",
    };
  }

  return { status: "ok" as const };
});
