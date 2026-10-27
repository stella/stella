import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { ONLINE_WORK_STATE_TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transitionUpsertBatch } from "@/api/lib/db/transitions";

const migration = readFileSync(
  nodePath.resolve(
    import.meta.dir,
    "../../drizzle/20261027000000_online_work_governor/migration.sql",
  ),
  "utf-8",
);

test("online work migration preserves foundation metadata and fences legacy claims during operator pauses", async () => {
  const client = await PGlite.create();
  try {
    await client.exec(`CREATE TABLE online_work_state (
      name text PRIMARY KEY, state text NOT NULL,
      CONSTRAINT online_work_state_state_check CHECK (state IN ('building', 'finalized', 'failed'))
    ); INSERT INTO online_work_state VALUES ('active', 'building'), ('complete', 'finalized');`);
    await client.exec(migration);
    expect(
      (
        await client.query(
          "SELECT name, state FROM online_work_state ORDER BY name",
        )
      ).rows,
    ).toEqual([
      { name: "active", state: "building" },
      { name: "complete", state: "finalized" },
    ]);
    const audit: string[] = [];
    await drizzle({ client }).transaction(async (tx) => {
      await transitionUpsertBatch({
        tx,
        spec: ONLINE_WORK_STATE_TRANSITIONS,
        onExisting: "preserve",
        values: [
          { name: "active", state: "running" },
          { name: "complete", state: "done" },
        ],
        recordTransitionAuditEvent: async (_tx, rows) => {
          for (const row of rows) {
            audit.push(row.status);
          }
        },
      });
    });
    expect(audit.toSorted()).toEqual(["done", "running"]);
    expect(
      (
        await client.query(
          "SELECT name, state FROM online_work_state ORDER BY name",
        )
      ).rows,
    ).toEqual([
      { name: "active", state: "running" },
      { name: "complete", state: "done" },
    ]);
    await client.exec(
      `UPDATE online_work_state SET state = 'paused', paused_by = 'operator', pause_reason = 'Maintenance test window', paused_until = now() + interval '1 hour' WHERE name = 'active'`,
    );
    const initial = (
      await client.query(
        "SELECT paused_since FROM online_work_state WHERE name = 'active'",
      )
    ).rows;
    expect(
      await rejectionOf(
        client.exec(
          "UPDATE online_work_state SET state = 'building' WHERE name = 'active'",
        ),
      ),
    ).toMatchObject({ message: expect.stringContaining("operator-paused") });
    await client.exec(
      "UPDATE online_work_state SET state = 'finalized' WHERE name = 'active'",
    );
    expect(
      (
        await client.query(
          "SELECT state FROM online_work_state WHERE name = 'active'",
        )
      ).rows,
    ).toEqual([{ state: "paused" }]);
    await client.exec(
      "UPDATE online_work_state SET paused_until = now() + interval '2 hours' WHERE name = 'active'",
    );
    expect(
      (
        await client.query(
          "SELECT paused_since FROM online_work_state WHERE name = 'active'",
        )
      ).rows,
    ).toEqual(initial);
    expect(
      await rejectionOf(
        client.exec(
          "UPDATE online_work_state SET paused_until = now() + interval '73 hours' WHERE name = 'active'",
        ),
      ),
    ).toMatchObject({ message: expect.stringContaining("72-hour maximum") });
    expect(
      await rejectionOf(
        client.exec(
          "UPDATE online_work_state SET paused_by = '' WHERE name = 'active'",
        ),
      ),
    ).toMatchObject({
      message: expect.stringContaining("online_work_state_pause_check"),
    });
    await client.exec(
      "UPDATE online_work_state SET state = 'pending', paused_until = NULL WHERE name = 'active'",
    );
    expect(
      (
        await client.query(
          "SELECT state, paused_since FROM online_work_state WHERE name = 'active'",
        )
      ).rows,
    ).toEqual([{ state: "pending", paused_since: null }]);
    await client.exec(
      "UPDATE online_work_state SET state = 'building' WHERE name = 'active'",
    );
    expect(
      (
        await client.query(
          "SELECT state FROM online_work_state WHERE name = 'active'",
        )
      ).rows,
    ).toEqual([{ state: "running" }]);
    await client.exec(
      "UPDATE online_work_state SET state = 'finalized' WHERE name = 'active'",
    );
    expect(
      (
        await client.query(
          "SELECT state FROM online_work_state WHERE name = 'active'",
        )
      ).rows,
    ).toEqual([{ state: "done" }]);
  } finally {
    await client.close();
  }
});
