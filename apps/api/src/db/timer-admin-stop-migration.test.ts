import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

const RUNNING_TIMER_ID = "00000000-0000-4000-8000-000000000001";
const PAUSED_TIMER_ID = "00000000-0000-4000-8000-000000000002";
const FOREIGN_TIMER_ID = "00000000-0000-4000-8000-000000000003";

const createDatabase = async (role: string) => {
  const db = await PGlite.create();
  await db.exec(`
    CREATE ROLE stella;
    CREATE TABLE organization (id varchar(128) PRIMARY KEY);
    CREATE TABLE "user" (id text PRIMARY KEY);
    CREATE TABLE "member" (organization_id varchar(128) NOT NULL, user_id text NOT NULL, role text NOT NULL, PRIMARY KEY (organization_id, user_id));
    GRANT SELECT ON "member" TO stella;
    CREATE TABLE workspaces (id uuid PRIMARY KEY, organization_id varchar(128) NOT NULL, UNIQUE (id, organization_id));
    CREATE TABLE time_entries (
      id uuid PRIMARY KEY, organization_id varchar(128), user_id text,
      workspace_id uuid, narrative text, status text, source text,
      timer_started_at timestamptz, timer_stopped_at timestamptz,
      created_at timestamptz DEFAULT now()
    );
    INSERT INTO organization VALUES ('org-a'), ('org-b');
    INSERT INTO "user" VALUES ('manager'), ('member-a'), ('member-b');
    INSERT INTO "member" VALUES ('org-a', 'manager', 'member'), ('org-a', 'member-a', 'member'), ('org-b', 'member-b', 'member');
  `);
  await db.query("UPDATE member SET role = $1 WHERE user_id = 'manager'", [
    role,
  ]);
  await db.exec(
    await Bun.file(
      new URL(
        "../../drizzle/20261003122300_global_timers/migration.sql",
        import.meta.url,
      ),
    ).text(),
  );
  await db.exec(
    await Bun.file(
      new URL(
        "../../drizzle/20261003122400_timer_admin_stop/migration.sql",
        import.meta.url,
      ),
    ).text(),
  );
  await db.query(
    `INSERT INTO time_timers (id, organization_id, user_id, state, started_at, last_resumed_at) VALUES
    ($1, 'org-a', 'member-a', 'running', now(), now()),
    ($2, 'org-a', 'member-a', 'paused', now(), NULL),
    ($3, 'org-b', 'member-b', 'running', now(), now())`,
    [RUNNING_TIMER_ID, PAUSED_TIMER_ID, FOREIGN_TIMER_ID],
  );
  await db.exec(
    `SET ROLE stella; SET app.organization_id = 'org-a'; SET app.user_id = 'manager';`,
  );
  return db;
};

test.each(["owner", "admin"])(
  "%s can read and end only running timers in the active organization",
  async (role) => {
    await using db = await createDatabase(role);
    expect((await db.query("SELECT id FROM time_timers")).rows).toEqual([
      { id: RUNNING_TIMER_ID },
    ]);
    expect(
      (
        await db.query(
          "UPDATE time_timers SET description = 'Changed' RETURNING id",
        )
      ).rows,
    ).toEqual([]);
    await expect(
      db.exec(
        `INSERT INTO time_timers (id, organization_id, user_id, state, started_at) VALUES (gen_random_uuid(), 'org-a', 'member-a', 'paused', now())`,
      ),
    ).rejects.toThrow(/row-level security/u);
    expect(
      (
        await db.query("DELETE FROM time_timers WHERE id = $1 RETURNING id", [
          PAUSED_TIMER_ID,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.query("DELETE FROM time_timers WHERE id = $1 RETURNING id", [
          FOREIGN_TIMER_ID,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.query("DELETE FROM time_timers WHERE id = $1 RETURNING id", [
          RUNNING_TIMER_ID,
        ])
      ).rows,
    ).toEqual([{ id: RUNNING_TIMER_ID }]);
    await db.exec("RESET ROLE");
    expect(
      (await db.query("SELECT id FROM time_timers ORDER BY id")).rows,
    ).toEqual([{ id: PAUSED_TIMER_ID }, { id: FOREIGN_TIMER_ID }]);
  },
);

test.each(["member", "intern", "external"])(
  "%s cannot see or end another owner's timers",
  async (role) => {
    await using db = await createDatabase(role);
    expect((await db.query("SELECT id FROM time_timers")).rows).toEqual([]);
    expect(
      (await db.query("DELETE FROM time_timers RETURNING id")).rows,
    ).toEqual([]);
    await expect(
      db.query(
        "INSERT INTO time_timer_confirmations (timer_id, organization_id, user_id) VALUES ($1, 'org-a', 'member-a')",
        [RUNNING_TIMER_ID],
      ),
    ).rejects.toThrow(/row-level security/u);
    await db.exec("SET app.user_id = 'member-a'");
    expect(
      (await db.query("SELECT id FROM time_timers ORDER BY id")).rows,
    ).toEqual([{ id: RUNNING_TIMER_ID }, { id: PAUSED_TIMER_ID }]);
  },
);

test("admin receipt replay stays in the active organization and cannot alter receipts", async () => {
  await using db = await createDatabase("admin");
  await db.query(
    "INSERT INTO time_timer_confirmations (timer_id, organization_id, user_id) VALUES ($1, 'org-a', 'member-a')",
    [RUNNING_TIMER_ID],
  );
  expect(
    (await db.query("SELECT timer_id FROM time_timer_confirmations")).rows,
  ).toEqual([{ timer_id: RUNNING_TIMER_ID }]);
  expect(
    (
      await db.query(
        "UPDATE time_timer_confirmations SET time_entry_id = NULL RETURNING timer_id",
      )
    ).rows,
  ).toEqual([]);
  expect(
    (await db.query("DELETE FROM time_timer_confirmations RETURNING timer_id"))
      .rows,
  ).toEqual([]);
  await expect(
    db.query(
      "INSERT INTO time_timer_confirmations (timer_id, organization_id, user_id) VALUES ($1, 'org-b', 'member-b')",
      [FOREIGN_TIMER_ID],
    ),
  ).rejects.toThrow(/row-level security/u);
  await db.exec("RESET ROLE");
  await db.query(
    "INSERT INTO time_timer_confirmations (timer_id, organization_id, user_id) VALUES ($1, 'org-b', 'member-b')",
    [FOREIGN_TIMER_ID],
  );
  await db.exec("SET ROLE stella");
  expect(
    (await db.query("SELECT timer_id FROM time_timer_confirmations")).rows,
  ).toEqual([{ timer_id: RUNNING_TIMER_ID }]);
  await db.exec(
    "RESET ROLE; UPDATE member SET role = 'member' WHERE user_id = 'manager'; SET ROLE stella;",
  );
  expect(
    (await db.query("SELECT timer_id FROM time_timer_confirmations")).rows,
  ).toEqual([]);
});

test("admin access still requires current target and actor membership and FORCE RLS", async () => {
  await using db = await createDatabase("admin");
  await db.exec(
    "RESET ROLE; DELETE FROM member WHERE user_id = 'member-a'; SET ROLE stella;",
  );
  expect((await db.query("SELECT id FROM time_timers")).rows).toEqual([]);
  expect((await db.query("DELETE FROM time_timers RETURNING id")).rows).toEqual(
    [],
  );
  await db.exec(
    "RESET ROLE; INSERT INTO member VALUES ('org-a', 'member-a', 'member'); DELETE FROM member WHERE user_id = 'manager'; SET ROLE stella;",
  );
  expect((await db.query("SELECT id FROM time_timers")).rows).toEqual([]);
  await db.exec("RESET ROLE");
  expect(
    (
      await db.query(
        "SELECT bool_and(relrowsecurity AND relforcerowsecurity) AS enforced FROM pg_class WHERE relname IN ('time_timers', 'time_timer_confirmations')",
      )
    ).rows,
  ).toEqual([{ enforced: true }]);
  expect(
    (
      await db.query(
        "SELECT polpermissive FROM pg_policy WHERE polrelid = 'time_timers'::regclass AND polname = 'current_member'",
      )
    ).rows,
  ).toEqual([{ polpermissive: false }]);
});
