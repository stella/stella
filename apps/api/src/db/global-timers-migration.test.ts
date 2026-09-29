import { PGlite } from "@electric-sql/pglite";
import { Result } from "better-result";
import { expect, test } from "bun:test";

const expectRejected = async (operation: Promise<unknown>, message: RegExp) => {
  const outcome = await Result.tryPromise(() => operation);
  expect(outcome.isErr()).toBe(true);
  if (outcome.isErr()) {
    expect(outcome.error.cause).toMatchObject({
      message: expect.stringMatching(message),
    });
  }
};

const createDatabase = async () => {
  const db = await PGlite.create();
  await db.exec(`
    CREATE ROLE stella;
    CREATE TABLE organization (id varchar(128) PRIMARY KEY);
    CREATE TABLE "user" (id text PRIMARY KEY);
    CREATE TABLE "member" (organization_id varchar(128) NOT NULL, user_id text NOT NULL, PRIMARY KEY (organization_id, user_id));
    GRANT SELECT ON "member" TO stella;
    CREATE TABLE workspaces (id uuid PRIMARY KEY, organization_id varchar(128) NOT NULL, UNIQUE (id, organization_id));
    CREATE TABLE time_entries (
      id uuid PRIMARY KEY, organization_id varchar(128), user_id text,
      workspace_id uuid, narrative text, status text, source text,
      timer_started_at timestamptz, timer_stopped_at timestamptz,
      created_at timestamptz DEFAULT now()
    );
    INSERT INTO organization VALUES ('org-a'), ('org-b');
    INSERT INTO "user" VALUES ('user-a'), ('user-b');
    INSERT INTO "member" VALUES ('org-a', 'user-a'), ('org-a', 'user-b'), ('org-b', 'user-a');
    INSERT INTO workspaces VALUES ('00000000-0000-4000-8000-000000000001', 'org-a');
    INSERT INTO time_entries (id, organization_id, user_id, workspace_id, narrative, status, source, timer_started_at)
      VALUES ('00000000-0000-4000-8000-000000000002', 'org-a', 'user-a', '00000000-0000-4000-8000-000000000001', 'Review', 'draft', 'timer', '2026-09-29T12:00:00Z');
  `);
  await db.exec(
    await Bun.file(
      new URL(
        "../../drizzle/20261003122300_global_timers/migration.sql",
        import.meta.url,
      ),
    ).text(),
  );
  return db;
};

const insertTimer = async (
  db: PGlite,
  organizationId: string,
  userId: string,
  state = "running",
) =>
  await db.query(
    `INSERT INTO time_timers (id, organization_id, user_id, state, started_at, last_resumed_at)
      VALUES (gen_random_uuid(), $1, $2, $3, now(), CASE WHEN $3 = 'running' THEN now() ELSE NULL END) RETURNING id`,
    [organizationId, userId, state],
  );

test("migration preserves active clocks and original drafts", async () => {
  await using db = await createDatabase();
  expect(
    (
      await db.query(`SELECT id = legacy_time_entry_id AS same_identity,
    started_at = '2026-09-29T12:00:00Z'::timestamptz AS original_start,
    started_at = last_resumed_at AS clock_preserved,
    accumulated_seconds, state, description FROM time_timers`)
    ).rows,
  ).toEqual([
    {
      same_identity: true,
      original_start: true,
      clock_preserved: true,
      accumulated_seconds: 0,
      state: "running",
      description: "Review",
    },
  ]);
  expect(
    (
      await db.query(
        "SELECT timer_started_at IS NOT NULL AS retained FROM time_entries",
      )
    ).rows,
  ).toEqual([{ retained: true }]);
});

test("database permits paused timers and one running timer per organization and owner", async () => {
  await using db = await createDatabase();
  await expectRejected(
    insertTimer(db, "org-a", "user-a"),
    /time_timers_one_running_owner_idx/u,
  );
  await insertTimer(db, "org-a", "user-a", "paused");
  await insertTimer(db, "org-a", "user-a", "paused");
  await insertTimer(db, "org-a", "user-b");
  await insertTimer(db, "org-b", "user-a");
  await expectRejected(
    db.exec(
      "UPDATE time_timers SET state = 'running', last_resumed_at = now() WHERE state = 'paused'",
    ),
    /time_timers_one_running_owner_idx/u,
  );
  await expectRejected(
    db.exec("UPDATE time_timers SET state = 'unknown', last_resumed_at = NULL"),
    /time_timers_state_check/u,
  );
  await expectRejected(
    db.exec("UPDATE time_timers SET accumulated_seconds = -1"),
    /time_timers_accumulated_seconds_check/u,
  );
  await expectRejected(
    db.exec(
      "UPDATE time_timers SET last_resumed_at = NULL WHERE state = 'running'",
    ),
    /time_timers_resume_state_check/u,
  );
});

test("owner-only timer and receipt policies protect reads and mutations", async () => {
  await using db = await createDatabase();
  await insertTimer(db, "org-a", "user-b");
  await insertTimer(db, "org-b", "user-a");
  await db.exec(`INSERT INTO time_timer_confirmations (timer_id, organization_id, user_id)
    SELECT id, organization_id, user_id FROM time_timers;
    SET ROLE stella;
    SET app.organization_id = 'org-a';
    SET app.user_id = 'user-a';`);
  for (const table of ["time_timers", "time_timer_confirmations"]) {
    expect(
      (await db.query(`SELECT user_id, organization_id FROM ${table}`)).rows,
    ).toEqual([{ user_id: "user-a", organization_id: "org-a" }]);
    await expectRejected(
      db.exec(`UPDATE ${table} SET user_id = 'user-b'`),
      /row-level security/u,
    );
    await expectRejected(
      db.exec(`UPDATE ${table} SET organization_id = 'org-b'`),
      /row-level security/u,
    );
    expect(
      (
        await db.query(
          `DELETE FROM ${table} WHERE user_id = 'user-b' RETURNING user_id`,
        )
      ).rows,
    ).toEqual([]);
  }
  await expectRejected(
    insertTimer(db, "org-a", "user-b", "paused"),
    /row-level security/u,
  );
  await expectRejected(
    insertTimer(db, "org-b", "user-a", "paused"),
    /row-level security/u,
  );
  await expectRejected(
    db.exec(
      `INSERT INTO time_timer_confirmations (timer_id, organization_id, user_id) VALUES (gen_random_uuid(), 'org-a', 'user-b')`,
    ),
    /row-level security/u,
  );
  await db.exec("RESET ROLE");
  expect(
    (
      await db.query(
        "SELECT bool_and(relrowsecurity AND relforcerowsecurity) AS enforced FROM pg_class WHERE relname IN ('time_timers', 'time_timer_confirmations')",
      )
    ).rows,
  ).toEqual([{ enforced: true }]);
});

test("receipts survive timer and entry deletion and reject duplicate identities", async () => {
  await using db = await createDatabase();
  await db.exec(`INSERT INTO time_timer_confirmations (timer_id, organization_id, user_id, time_entry_id)
    SELECT id, organization_id, user_id, legacy_time_entry_id FROM time_timers;
    DELETE FROM time_timers;
    DELETE FROM time_entries;`);
  expect(
    (await db.query("SELECT time_entry_id FROM time_timer_confirmations")).rows,
  ).toEqual([{ time_entry_id: null }]);
  await expectRejected(
    db.exec(`INSERT INTO time_timer_confirmations (timer_id, organization_id, user_id)
    VALUES ('00000000-0000-4000-8000-000000000002', 'org-a', 'user-a')`),
    /time_timer_confirmations_pkey/u,
  );
});

test("removed membership denies timer reads, start, resume and discard", async () => {
  await using db = await createDatabase();
  await db.exec(`
    UPDATE time_timers SET state = 'paused', last_resumed_at = NULL;
    DELETE FROM "member" WHERE organization_id = 'org-a' AND user_id = 'user-a';
    SET ROLE stella;
    SET app.organization_id = 'org-a';
    SET app.user_id = 'user-a';
  `);
  expect((await db.query("SELECT id FROM time_timers")).rows).toEqual([]);
  await expectRejected(
    insertTimer(db, "org-a", "user-a"),
    /row-level security/u,
  );
  expect(
    (
      await db.query(
        "UPDATE time_timers SET state = 'running', last_resumed_at = now() RETURNING id",
      )
    ).rows,
  ).toEqual([]);
  expect((await db.query("DELETE FROM time_timers RETURNING id")).rows).toEqual(
    [],
  );
  await db.exec("RESET ROLE");
  expect((await db.query("SELECT state FROM time_timers")).rows).toEqual([
    { state: "paused" },
  ]);
});

test("matter deletion clears the pointer while retaining the timer owner", async () => {
  await using db = await createDatabase();
  await db.exec("DELETE FROM workspaces");
  expect(
    (
      await db.query(
        "SELECT workspace_id, organization_id, user_id FROM time_timers",
      )
    ).rows,
  ).toEqual([
    { workspace_id: null, organization_id: "org-a", user_id: "user-a" },
  ]);
});
