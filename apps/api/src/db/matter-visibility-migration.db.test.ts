import { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

/**
 * Matter visibility replaces "no client means private".
 *
 * The shared test database runs every migration before any matter exists, so
 * it never holds a clientless matter from before the column. This suite seeds
 * the tables the migration reads in their pre-migration shape, runs the
 * migration file itself, and checks the backfill, the transitional insert
 * trigger, and the rewritten access view.
 */

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20261014120000_matter_visibility/migration.sql",
);

const migrationSql = readFileSync(MIGRATION_PATH, "utf-8")
  .replaceAll("--> statement-breakpoint", "")
  // The migrator runs inside a transaction; PGlite's exec does not open one,
  // so SET LOCAL would only warn. Plain SET keeps the budget for the session.
  .replaceAll("SET LOCAL", "SET");

const ORG = "org_visibility";
const OTHER_ORG = "org_other";
const OWNER = "user_owner";
const ADMIN = "user_admin";
const MEMBER = "user_member";
const OTHER_MEMBER = "user_other_member";
const EXTERNAL = "user_external";
const INTERN = "user_intern";

const MATTER = {
  clientMatter: "00000000-0000-4000-8000-000000000001",
  clientlessOfMember: "00000000-0000-4000-8000-000000000002",
  clientlessOfOther: "00000000-0000-4000-8000-000000000003",
  otherOrgClientMatter: "00000000-0000-4000-8000-000000000004",
} as const;

const CLIENT = "00000000-0000-4000-8000-0000000000c1";

// Only the columns the migration and its view read.
const SCHEMA = `
CREATE TABLE member (
  id text PRIMARY KEY,
  organization_id varchar(128) NOT NULL,
  user_id text NOT NULL,
  role text NOT NULL
);
CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  organization_id varchar(128) NOT NULL,
  client_id uuid,
  lead_user_id text,
  status text NOT NULL DEFAULT 'active'
);
CREATE TABLE workspace_members (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

const seed = async (database: PGlite): Promise<void> => {
  await database.exec(SCHEMA);
  await database.exec(`
    INSERT INTO member VALUES
      ('m1', '${ORG}', '${OWNER}', 'owner'),
      ('m2', '${ORG}', '${ADMIN}', 'admin'),
      ('m3', '${ORG}', '${MEMBER}', 'member'),
      ('m4', '${ORG}', '${OTHER_MEMBER}', 'member'),
      ('m6', '${ORG}', '${EXTERNAL}', 'external'),
      ('m7', '${ORG}', '${INTERN}', 'intern'),
      ('m5', '${OTHER_ORG}', '${OWNER}', 'owner');
    INSERT INTO workspaces (id, organization_id, client_id) VALUES
      ('${MATTER.clientMatter}', '${ORG}', '${CLIENT}'),
      ('${MATTER.clientlessOfMember}', '${ORG}', NULL),
      ('${MATTER.clientlessOfOther}', '${ORG}', NULL),
      ('${MATTER.otherOrgClientMatter}', '${OTHER_ORG}', '${CLIENT}');
    INSERT INTO workspace_members VALUES
      ('wm1', '${MATTER.clientlessOfMember}', '${MEMBER}'),
      ('wm2', '${MATTER.clientlessOfOther}', '${OTHER_MEMBER}'),
      ('wm3', '${MATTER.clientMatter}', '${MEMBER}');
  `);
};

const migrated = async (): Promise<PGlite> => {
  const database = new PGlite();
  await seed(database);
  await database.exec(migrationSql);
  return database;
};

const visibilityById = async (database: PGlite) =>
  Object.fromEntries(
    (
      await database.query<{ id: string; visibility: string }>(
        "SELECT id, visibility FROM workspaces ORDER BY id",
      )
    ).rows.map(({ id, visibility }) => [id, visibility]),
  );

/** The matters the access view grants one user in one organization. */
const authorizedFor = async (
  database: PGlite,
  { organizationId, userId }: { organizationId: string; userId: string },
): Promise<string[]> => {
  await database.query(
    "SELECT set_config('app.workspace_access_mode', 'membership', false), set_config('app.organization_id', $1, false), set_config('app.user_id', $2, false), set_config('app.workspace_ids', '', false)",
    [organizationId, userId],
  );
  const { rows } = await database.query<{ id: string }>(
    "SELECT DISTINCT authorized_workspace_id::text AS id FROM public.stella_authorized_workspaces ORDER BY 1",
  );
  return rows.map(({ id }) => id);
};

describe("matter visibility migration", () => {
  test("backfill keeps every clientless matter assigned-only and every client matter admins-and-assigned; nothing becomes all-members", async () => {
    await using database = await migrated();

    expect(await visibilityById(database)).toEqual({
      [MATTER.clientMatter]: "admins_and_assigned",
      [MATTER.clientlessOfMember]: "assigned_only",
      [MATTER.clientlessOfOther]: "assigned_only",
      [MATTER.otherOrgClientMatter]: "admins_and_assigned",
    });
  });

  test("every assigned-only matter keeps a lead who can manage it; a matter nobody could manage stays reachable by owners and admins", async () => {
    const leadless = "00000000-0000-4000-8000-000000000011";
    const keptLead = "00000000-0000-4000-8000-000000000012";
    const memberless = "00000000-0000-4000-8000-000000000013";
    const externalOnly = "00000000-0000-4000-8000-000000000014";
    await using database = new PGlite();
    await seed(database);
    await database.exec(`
      INSERT INTO workspaces (id, organization_id, client_id, lead_user_id) VALUES
        ('${leadless}', '${ORG}', NULL, NULL),
        ('${keptLead}', '${ORG}', NULL, '${OTHER_MEMBER}'),
        ('${memberless}', '${ORG}', NULL, NULL),
        ('${externalOnly}', '${ORG}', NULL, NULL);
      INSERT INTO workspace_members (id, workspace_id, user_id, created_at) VALUES
        ('wl1', '${leadless}', '${EXTERNAL}', '2026-01-01T00:00:00Z'),
        ('wl2', '${leadless}', '${MEMBER}', '2026-01-02T00:00:00Z'),
        ('wl3', '${leadless}', '${OTHER_MEMBER}', '2026-01-03T00:00:00Z'),
        ('wk1', '${keptLead}', '${MEMBER}', '2026-01-01T00:00:00Z'),
        ('wk2', '${keptLead}', '${OTHER_MEMBER}', '2026-01-02T00:00:00Z'),
        ('we1', '${externalOnly}', '${EXTERNAL}', '2026-01-01T00:00:00Z');
    `);
    await database.exec(migrationSql);

    const leads = Object.fromEntries(
      (
        await database.query<{ id: string; lead: string | null }>(
          "SELECT id::text AS id, lead_user_id AS lead FROM workspaces",
        )
      ).rows.map(({ id, lead }) => [id, lead]),
    );
    // The earliest assigned internal member becomes the lead; an external
    // member assigned earlier is passed over, and a stated lead is kept.
    expect(leads[leadless]).toBe(MEMBER);
    expect(leads[keptLead]).toBe(OTHER_MEMBER);
    expect(leads[memberless]).toBeNull();
    expect(leads[externalOnly]).toBeNull();

    const visibility = await visibilityById(database);
    expect(visibility[leadless]).toBe("assigned_only");
    expect(visibility[keptLead]).toBe("assigned_only");
    expect(visibility[memberless]).toBe("admins_and_assigned");
    expect(visibility[externalOnly]).toBe("admins_and_assigned");

    // The new lead is assigned, so they reach the matter they now manage.
    expect(
      await authorizedFor(database, { organizationId: ORG, userId: MEMBER }),
    ).toContain(leadless);
    // Owners and admins can recover the matters without a usable lead.
    for (const userId of [OWNER, ADMIN]) {
      const granted = await authorizedFor(database, {
        organizationId: ORG,
        userId,
      });
      expect(granted).toContain(memberless);
      expect(granted).toContain(externalOnly);
      expect(granted).not.toContain(leadless);
    }
  });

  test("nothing becomes newly visible: each user's access set is the same before and after", async () => {
    // Before: the old rule, owners and admins reach client matters.
    const legacyRule = async (database: PGlite, userId: string) =>
      (
        await database.query<{ id: string }>(
          `SELECT DISTINCT w.id::text AS id
             FROM workspaces w
             JOIN member m ON m.organization_id = w.organization_id AND m.user_id = $1
            WHERE w.organization_id = $2
              AND (
                EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = $1)
                OR (m.role IN ('owner', 'admin') AND w.client_id IS NOT NULL)
              )
            ORDER BY 1`,
          [userId, ORG],
        )
      ).rows.map(({ id }) => id);

    await using database = new PGlite();
    await seed(database);
    const before = Object.fromEntries(
      await Promise.all(
        [OWNER, ADMIN, MEMBER, OTHER_MEMBER, EXTERNAL, INTERN].map(
          async (userId) =>
            [userId, await legacyRule(database, userId)] as const,
        ),
      ),
    );
    await database.exec(migrationSql);

    for (const userId of [
      OWNER,
      ADMIN,
      MEMBER,
      OTHER_MEMBER,
      EXTERNAL,
      INTERN,
    ]) {
      expect(
        await authorizedFor(database, { organizationId: ORG, userId }),
      ).toEqual(
        before[userId] ?? panic(`No pre-migration access set for ${userId}`),
      );
    }
  });

  test("owners and admins reach admins-and-assigned matters with or without a client, never an assigned-only matter they are not on", async () => {
    await using database = await migrated();
    const clientlessOrganizationMatter = "00000000-0000-4000-8000-000000000005";
    const privateClientMatter = "00000000-0000-4000-8000-000000000006";
    await database.exec(`
      INSERT INTO workspaces (id, organization_id, client_id, visibility) VALUES
        ('${clientlessOrganizationMatter}', '${ORG}', NULL, 'admins_and_assigned'),
        ('${privateClientMatter}', '${ORG}', '${CLIENT}', 'assigned_only');
      INSERT INTO workspace_members VALUES
        ('wm4', '${privateClientMatter}', '${OTHER_MEMBER}');
    `);

    for (const userId of [OWNER, ADMIN]) {
      const granted = await authorizedFor(database, {
        organizationId: ORG,
        userId,
      });
      expect(granted).toContain(clientlessOrganizationMatter);
      expect(granted).toContain(MATTER.clientMatter);
      expect(granted).not.toContain(privateClientMatter);
      expect(granted).not.toContain(MATTER.clientlessOfMember);
      expect(granted).not.toContain(MATTER.otherOrgClientMatter);
    }

    // A plain member reaches only what they are assigned to below the
    // all-members level.
    expect(
      await authorizedFor(database, { organizationId: ORG, userId: MEMBER }),
    ).toEqual([MATTER.clientMatter, MATTER.clientlessOfMember].toSorted());
    expect(
      await authorizedFor(database, {
        organizationId: ORG,
        userId: OTHER_MEMBER,
      }),
    ).toEqual([MATTER.clientlessOfOther, privateClientMatter].toSorted());
  });

  test("an all-members matter reaches every internal member without an assignment, never an external one", async () => {
    await using database = await migrated();
    const allMembersMatter = "00000000-0000-4000-8000-000000000007";
    await database.exec(`
      INSERT INTO workspaces (id, organization_id, client_id, visibility) VALUES
        ('${allMembersMatter}', '${ORG}', NULL, 'all_members');
    `);

    for (const userId of [OWNER, ADMIN, MEMBER, OTHER_MEMBER, INTERN]) {
      expect(
        await authorizedFor(database, { organizationId: ORG, userId }),
      ).toContain(allMembersMatter);
    }
    expect(
      await authorizedFor(database, { organizationId: ORG, userId: EXTERNAL }),
    ).toEqual([]);
    // Another organization's owner never reaches it.
    expect(
      await authorizedFor(database, {
        organizationId: OTHER_ORG,
        userId: OWNER,
      }),
    ).not.toContain(allMembersMatter);

    // Narrowed to admins and assigned members: unassigned members lose it.
    await database.exec(
      `UPDATE workspaces SET visibility = 'admins_and_assigned' WHERE id = '${allMembersMatter}'`,
    );
    expect(
      await authorizedFor(database, { organizationId: ORG, userId: MEMBER }),
    ).not.toContain(allMembersMatter);
    expect(
      await authorizedFor(database, { organizationId: ORG, userId: OWNER }),
    ).toContain(allMembersMatter);
  });

  test("a writer that omits visibility gets the visibility the old rule implied", async () => {
    await using database = await migrated();
    await database.exec(`
      INSERT INTO workspaces (id, organization_id, client_id) VALUES
        ('00000000-0000-4000-8000-0000000000a1', '${ORG}', NULL),
        ('00000000-0000-4000-8000-0000000000a2', '${ORG}', '${CLIENT}');
      INSERT INTO workspaces (id, organization_id, client_id, visibility) VALUES
        ('00000000-0000-4000-8000-0000000000a3', '${ORG}', NULL, 'all_members'),
        ('00000000-0000-4000-8000-0000000000a4', '${ORG}', '${CLIENT}', 'assigned_only');
    `);

    const visibility = await visibilityById(database);
    expect(visibility["00000000-0000-4000-8000-0000000000a1"]).toBe(
      "assigned_only",
    );
    expect(visibility["00000000-0000-4000-8000-0000000000a2"]).toBe(
      "admins_and_assigned",
    );
    // An explicit value always wins.
    expect(visibility["00000000-0000-4000-8000-0000000000a3"]).toBe(
      "all_members",
    );
    expect(visibility["00000000-0000-4000-8000-0000000000a4"]).toBe(
      "assigned_only",
    );
  });

  test("the column refuses any other value and has no default", async () => {
    await using database = await migrated();

    expect(
      String(
        await rejectionOf(
          database.exec(
            `INSERT INTO workspaces (id, organization_id, visibility) VALUES ('00000000-0000-4000-8000-0000000000b1', '${ORG}', 'public')`,
          ),
        ),
      ),
    ).toMatch(/workspaces_visibility_check/u);
    expect(
      String(
        await rejectionOf(
          database.exec(
            `UPDATE workspaces SET visibility = NULL WHERE id = '${MATTER.clientMatter}'`,
          ),
        ),
      ),
    ).toMatch(/null value/u);

    const { rows } = await database.query<{ column_default: string | null }>(
      "SELECT column_default FROM information_schema.columns WHERE table_name = 'workspaces' AND column_name = 'visibility'",
    );
    expect(rows).toEqual([{ column_default: null }]);
  });
});
