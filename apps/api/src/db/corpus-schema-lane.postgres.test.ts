import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { withGatedTestClients } from "../tests/gated-test-database";
import {
  CORPUS_SCHEMA_LANE_LOCK_SQL,
  CORPUS_SCHEMA_LANE_LOCK_STATEMENTS,
  CORPUS_SCHEMA_LANE_UNLOCK_SQL,
} from "./corpus-schema-lane";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const SHARED_LOCK_SQL = CORPUS_SCHEMA_LANE_LOCK_SQL.replace(
  "pg_advisory_lock(",
  "pg_advisory_lock_shared(",
);
const SHARED_UNLOCK_SQL = CORPUS_SCHEMA_LANE_UNLOCK_SQL.replace(
  "pg_advisory_unlock(",
  "pg_advisory_unlock_shared(",
);

/** Longer than the short session lock timeout below, so a held lane outlasts it. */
const SHARED_HOLD_MS = 400;

describe.skipIf(!enabled)("corpus schema lane", () => {
  // A deferred migrate run takes the lane again on the session its online
  // phase left with a short lock timeout, while a corpus writer holds the
  // lane shared.
  test("waits out a shared holder on a session that carries a short lock timeout", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL is required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const writer = openClient().sql;
      const migrating = await openClient().sql.reserve();
      await migrating.unsafe("SET lock_timeout = '100ms'");
      await writer.unsafe(SHARED_LOCK_SQL);
      let writerHolds = true;
      try {
        const refused = await migrating
          .unsafe(CORPUS_SCHEMA_LANE_LOCK_SQL)
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(refused).toMatchObject({ errno: "55P03" });

        const { lift, lock, restore } = CORPUS_SCHEMA_LANE_LOCK_STATEMENTS;
        for (const statement of lift) {
          await migrating.unsafe(statement);
        }
        const taking = migrating.unsafe(lock);
        // real-time: the lock timeout runs on the server's clock, so the hold
        // must outlast it in wall time to prove the wait no longer obeys it.
        await Bun.sleep(SHARED_HOLD_MS);
        await writer.unsafe(SHARED_UNLOCK_SQL);
        writerHolds = false;
        await taking;
        for (const statement of restore) {
          await migrating.unsafe(statement);
        }
        await migrating.unsafe(CORPUS_SCHEMA_LANE_UNLOCK_SQL);
      } finally {
        if (writerHolds) {
          await writer.unsafe(SHARED_UNLOCK_SQL);
        }
        await migrating.release();
      }
    });
  });
});
