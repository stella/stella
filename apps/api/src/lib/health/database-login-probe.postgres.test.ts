import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  attemptFreshLogin,
  openFreshLoginClient,
} from "@/api/lib/health/database-login-probe";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

/**
 * A pooled session authenticated once keeps working after its login's
 * password changes; only a new login sees the change. The check opens a new
 * login with the URL it was given, so it reports what the pool cannot.
 */

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const SINK_EVENT = "db.fresh_login";

const randomHex = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");

const loginUrl = (base: string, user: string, password: string): string => {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  return url.toString();
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("database login check against Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("database login check against Postgres", () => {
    let logs: RecordingLogger;
    let analytics: RecordingAnalytics;

    beforeEach(() => {
      logs = installRecordingLogger();
      analytics = installRecordingAnalytics();
    });

    afterEach(() => {
      logs.restore();
      analytics.restore();
    });

    test("reports a login the pool no longer exercises, without its URL or password", async () => {
      // Hex only, so both are safe to splice into DDL.
      const role = `stella_login_check_${randomHex().slice(0, 16)}`;
      const firstPassword = randomHex();
      const secondPassword = randomHex();
      const firstUrl = loginUrl(databaseUrl, role, firstPassword);

      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const owner = openClient().sql;
        await owner.unsafe(
          `CREATE ROLE "${role}" LOGIN PASSWORD '${firstPassword}'`,
        );
        try {
          await withGatedTestClients(
            firstUrl,
            async ({ openClient: openPooled }) => {
              const pooled = openPooled({ max: 1 }).sql;
              const [before] = await pooled<
                { pid: number }[]
              >`SELECT pg_backend_pid() AS pid`;

              await owner.unsafe(
                `ALTER ROLE "${role}" PASSWORD '${secondPassword}'`,
              );

              const [after] = await pooled<
                { pid: number; user: string }[]
              >`SELECT pg_backend_pid() AS pid, current_user AS user`;
              expect(after).toEqual({ pid: before?.pid ?? -1, user: role });

              await attemptFreshLogin({
                openClient: () => openFreshLoginClient(firstUrl),
                signal: new AbortController().signal,
              });
            },
          );
        } finally {
          await owner.unsafe(`DROP ROLE IF EXISTS "${role}"`);
        }
      });

      const records = logs.records.filter(
        (record) => record.message === SINK_EVENT,
      );
      expect(records).toHaveLength(1);
      const [record] = records;
      expect(record?.severityText).toBe("ERROR");
      expect(record?.attributes).toMatchObject({
        "failure.grade": "defect",
        "failure.reason": "pg_auth_failed",
        "failure.sink": SINK_EVENT,
        "error.sqlstate": "28P01",
      });
      expect(analytics.exceptions()).toHaveLength(1);

      const emitted = JSON.stringify({
        records: logs.records,
        events: analytics.events,
      });
      for (const secret of [firstUrl, firstPassword, secondPassword]) {
        expect(emitted).not.toContain(secret);
      }
    });
  });
}
