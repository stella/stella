import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { withFreshIndicatorDatabase } from "@/api/tests/database-load-indicator-fixture";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = process.env["DATABASE_URL"];

describe.skipIf(!enabled)("database pressure fleet cache", () => {
  test("concurrent callers share refresh admission, publish by token and keep the last real snapshot", async () => {
    const url =
      databaseUrl ?? panic("Pressure PostgreSQL tests require DATABASE_URL");
    await withFreshIndicatorDatabase(url, async ({ client }) => {
      const migration = await Bun.file(
        new URL(
          "../../drizzle/20261027000001_database_pressure/migration.sql",
          import.meta.url,
        ),
      ).text();
      await client.begin(async (tx) => {
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim().length > 0) {
            await tx.unsafe(statement);
          }
        }
      });
      for (const count of [10, 100]) {
        const name = `fixture-${count}`;
        const claims = await Promise.all(
          Array.from({ length: count }, async (_, index) =>
            (
              await client.unsafe<{ claimed: boolean; snapshot: unknown }[]>(
                "SELECT * FROM public.stella_database_pressure_cache_claim($1, $2)",
                [name, `token-${index}`],
              )
            ).at(0),
          ),
        );
        expect(claims.filter((claim) => claim?.claimed)).toHaveLength(1);
        const winner = claims.findIndex((claim) => claim?.claimed);
        const reading = {
          cpu_percent: 10,
          read_iops: 20,
          write_iops: 30,
          read_bytes_per_second: 40,
          write_bytes_per_second: 50,
          observedAt: "2026-10-27T12:00:00Z",
        };
        await client.unsafe(
          "SELECT public.stella_database_pressure_cache_publish($1, $2, $3::text::jsonb)",
          [name, "wrong-token", JSON.stringify(reading)],
        );
        expect(
          (
            await client.unsafe<{ snapshot: unknown }[]>(
              "SELECT snapshot FROM public.database_pressure_cache WHERE instance_identifier=$1",
              [name],
            )
          ).at(0)?.snapshot,
        ).toBeNull();
        await client.unsafe(
          "SELECT public.stella_database_pressure_cache_publish($1, $2, $3::text::jsonb)",
          [name, `token-${winner}`, JSON.stringify(reading)],
        );
        const cached = (
          await client.unsafe<{ claimed: boolean; snapshot: unknown }[]>(
            "SELECT * FROM public.stella_database_pressure_cache_claim($1, $2)",
            [name, "later-reader"],
          )
        ).at(0);
        expect(cached?.claimed).toBe(false);
        expect(cached?.snapshot).toEqual(reading);
        await client.unsafe(
          "UPDATE public.database_pressure_cache SET next_refresh_at=clock_timestamp() WHERE instance_identifier=$1",
          [name],
        );
        const refreshed = (
          await client.unsafe<{ claimed: boolean; snapshot: unknown }[]>(
            "SELECT * FROM public.stella_database_pressure_cache_claim($1, $2)",
            [name, "refresh-owner"],
          )
        ).at(0);
        expect(refreshed?.claimed).toBe(true);
        expect(refreshed?.snapshot).toEqual(reading);
      }
      const pressure = (
        await client.unsafe<
          {
            active_sessions: number;
            replication_lag_ms: number;
            observed_at: Date;
          }[]
        >("SELECT * FROM public.stella_database_pressure_indicators()")
      ).at(0);
      expect(typeof pressure?.active_sessions).toBe("number");
      expect(pressure?.replication_lag_ms).toBe(0);
      expect(pressure?.observed_at).toBeInstanceOf(Date);
      const denied = await client.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE stella_ingestion");
        return (
          await tx.unsafe<{ claimed: boolean }[]>(
            "SELECT claimed FROM public.stella_database_pressure_cache_claim($1, $2)",
            ["ingestion-fixture", "ingestion-token"],
          )
        ).at(0);
      });
      expect(denied?.claimed).toBe(true);
    });
  });
});
