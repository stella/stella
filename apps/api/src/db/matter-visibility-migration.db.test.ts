import { PGlite } from "@electric-sql/pglite";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import type { Verdict } from "@stll/db-load-gate/health";
import { rejectionOf } from "@stll/property-testing/rejection";

import { toSafeId } from "@/api/lib/branded-types";
import {
  brandPersistedOrganizationId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import {
  withLegacyWorkspaceFixture,
  withPgliteWorkspaceCreation,
} from "@/api/tests/helpers/workspace-creation";

import { createMatterVisibilityRepair } from "./matter-visibility-repair";
import { createUngatedTableGateForTests } from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";

/**
 * Matter visibility replaces "no client means private".
 *
 * The shared test database runs every migration before any matter exists, so
 * it never holds a clientless matter from before the column. This suite seeds
 * the tables the migration reads in their pre-migration shape, runs the
 * migration and its online repair, and checks the backfill, the transitional insert
 * trigger, and the rewritten access view.
 */

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20261029074600_matter_visibility/migration.sql",
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
CREATE ROLE stella;
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
  for (const path of [
    "20261001123000_database_backfill_state/migration.sql",
    "20261015090000_matter_access_rule_function/migration.sql",
  ]) {
    await database.exec(
      readFileSync(
        nodePath.resolve(import.meta.dir, "../../drizzle", path),
        "utf-8",
      )
        .replaceAll("--> statement-breakpoint", "")
        .replaceAll("SET LOCAL", "SET"),
    );
  }
  await withLegacyWorkspaceFixture({
    tx: drizzle({ client: database }),
    insert: async () =>
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
  `),
  });
};

const lockStewardship = async (
  database: PGlite,
  workspaceIds: readonly string[],
  userIds: readonly string[],
) => {
  await database.query(
    "SELECT public.stella_lock_matter_stewardship($1::text::jsonb, 'update')",
    [
      JSON.stringify([
        {
          organization_id: ORG,
          workspace_ids: workspaceIds,
          user_ids: userIds,
          membership_user_ids: userIds,
        },
      ]),
    ],
  );
};

const normalVerdict = {
  kind: "normal",
  signals: [],
} as const satisfies Verdict;

const repair = createMatterVisibilityRepair({
  readVerdict: async () => normalVerdict,
  sleep: async () => {},
});

const connectionOver = (database: PGlite): OnlineMigrationConnection => ({
  execute: async (statement, parameters = []) => {
    await database.query(statement, [...parameters]);
  },
  query: async (statement, parameters = []) =>
    (await database.query(statement, [...parameters])).rows,
  release: () => {},
});

const applyVisibility = async (database: PGlite) => {
  await database.exec(migrationSql);
  const connection = connectionOver(database);
  await repair.repair(connection, createUngatedTableGateForTests(connection));
};

const migrated = async (): Promise<PGlite> => {
  const database = new PGlite();
  await seed(database);
  await applyVisibility(database);
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
  test("an interrupted backfill blocks deployment, preserves legacy access, and resumes to an idempotent cutover", async () => {
    await using database = new PGlite();
    await seed(database);
    await withLegacyWorkspaceFixture({
      tx: drizzle({ client: database }),
      insert: async () =>
        await database.exec(`
      INSERT INTO workspaces (id, organization_id, lead_user_id)
      SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
        '${ORG}', '${MEMBER}' FROM generate_series(100, 209) i;
      INSERT INTO workspace_members (id, workspace_id, user_id)
      SELECT 'resume-' || i::text,
        ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
        '${MEMBER}' FROM generate_series(100, 209) i;
    `),
    });
    await database.exec(migrationSql);
    const connection = connectionOver(database);
    const tables = createUngatedTableGateForTests(connection);
    let now = Date.now();
    let reads = 0;
    const interrupted = createMatterVisibilityRepair({
      clock: () => now,
      sleep: async () => {},
      readVerdict: async () => {
        reads += 1;
        return reads === 1 ? normalVerdict : { kind: "stop", signals: [] };
      },
    });
    expect(await interrupted.readCompletion(connection)).toMatchObject({
      type: "incomplete",
    });
    expect(
      String(await rejectionOf(interrupted.repair(connection, tables))),
    ).toContain("Matter visibility backfill must finish before deployment");
    const checkpoint = await database.query<{ cursor: string | null }>(
      "SELECT cursor FROM database_backfill_states WHERE name = 'matter-visibility'",
    );
    expect(checkpoint.rows.at(0)?.cursor).toEqual(expect.any(String));
    expect(await interrupted.readCompletion(connection)).toMatchObject({
      type: "incomplete",
    });
    // Stored visibility already changed in the committed first batch; the
    // pre-cutover SQL rule still grants no unassigned clientless matter.
    const legacyAccess = await database.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM public.stella_authorized_workspace_ids($1, $2) ORDER BY 1",
      [ORG, OWNER],
    );
    expect(legacyAccess.rows.map(({ workspace_id }) => workspace_id)).toEqual([
      MATTER.clientMatter,
    ]);
    now += 86_400_000;
    const resumed = createMatterVisibilityRepair({
      clock: () => now,
      sleep: async () => {},
      readVerdict: async () => normalVerdict,
    });
    await resumed.repair(connection, tables);
    expect(await resumed.readCompletion(connection)).toEqual({
      type: "complete",
    });
    expect(
      Object.values(await visibilityById(database)).filter(
        (value) => value === "assigned_only",
      ),
    ).toHaveLength(112);
    await database.query(
      "UPDATE workspaces SET visibility = 'all_members' WHERE id = $1",
      [MATTER.clientlessOfMember],
    );
    const beforeReplay = await visibilityById(database);
    await resumed.repair(connection, tables);
    expect(await visibilityById(database)).toEqual(beforeReplay);
  });

  test("backfill keeps every clientless matter assigned-only and every client matter admins-and-assigned; nothing becomes all-members", async () => {
    await using database = await migrated();

    expect(await visibilityById(database)).toEqual({
      [MATTER.clientMatter]: "admins_and_assigned",
      [MATTER.clientlessOfMember]: "assigned_only",
      [MATTER.clientlessOfOther]: "assigned_only",
      [MATTER.otherOrgClientMatter]: "admins_and_assigned",
    });
  });

  test("legacy clientless matters without an internal assignee stay assigned-only pending handover", async () => {
    const leadless = "00000000-0000-4000-8000-000000000011";
    const keptLead = "00000000-0000-4000-8000-000000000012";
    const memberless = "00000000-0000-4000-8000-000000000013";
    const externalOnly = "00000000-0000-4000-8000-000000000014";
    const departedLead = "00000000-0000-4000-8000-000000000015";
    const unassignedLead = "00000000-0000-4000-8000-000000000016";
    const externalLead = "00000000-0000-4000-8000-000000000017";
    await using database = new PGlite();
    await seed(database);
    await withLegacyWorkspaceFixture({
      tx: drizzle({ client: database }),
      insert: async () =>
        await database.exec(`
      INSERT INTO workspaces (id, organization_id, client_id, lead_user_id) VALUES
        ('${leadless}', '${ORG}', NULL, NULL),
        ('${keptLead}', '${ORG}', NULL, '${OTHER_MEMBER}'),
        ('${memberless}', '${ORG}', NULL, NULL),
        ('${externalOnly}', '${ORG}', NULL, NULL),
        ('${departedLead}', '${ORG}', NULL, 'user_departed'),
        ('${unassignedLead}', '${ORG}', NULL, '${ADMIN}'),
        ('${externalLead}', '${ORG}', NULL, '${EXTERNAL}');
      INSERT INTO workspace_members (id, workspace_id, user_id, created_at) VALUES
        ('wl1', '${leadless}', '${EXTERNAL}', '2026-01-01T00:00:00Z'),
        ('wl2', '${leadless}', '${MEMBER}', '2026-01-02T00:00:00Z'),
        ('wl3', '${leadless}', '${OTHER_MEMBER}', '2026-01-03T00:00:00Z'),
        ('wk1', '${keptLead}', '${MEMBER}', '2026-01-01T00:00:00Z'),
        ('wk2', '${keptLead}', '${OTHER_MEMBER}', '2026-01-02T00:00:00Z'),
        ('we1', '${externalOnly}', '${EXTERNAL}', '2026-01-01T00:00:00Z'),
        ('wd1', '${departedLead}', 'user_departed', '2026-01-01T00:00:00Z'),
        ('wd2', '${departedLead}', '${OTHER_MEMBER}', '2026-01-02T00:00:00Z'),
        ('wu1', '${unassignedLead}', '${INTERN}', '2026-01-01T00:00:00Z'),
        ('wx1', '${externalLead}', '${EXTERNAL}', '2026-01-01T00:00:00Z'),
        ('wx2', '${externalLead}', '${MEMBER}', '2026-01-02T00:00:00Z');
    `),
    });
    await applyVisibility(database);

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
    // A lead who left the organization, is not assigned, or is external is
    // repaired the same way.
    expect(leads[departedLead]).toBe(OTHER_MEMBER);
    expect(leads[unassignedLead]).toBe(INTERN);
    expect(leads[externalLead]).toBe(MEMBER);

    const visibility = await visibilityById(database);
    expect(visibility[leadless]).toBe("assigned_only");
    expect(visibility[keptLead]).toBe("assigned_only");
    expect(visibility[memberless]).toBe("assigned_only");
    expect(visibility[externalOnly]).toBe("assigned_only");
    for (const repaired of [departedLead, unassignedLead, externalLead]) {
      expect(visibility[repaired]).toBe("assigned_only");
    }

    // The new lead is assigned, so they reach the matter they now manage.
    expect(
      await authorizedFor(database, { organizationId: ORG, userId: MEMBER }),
    ).toContain(leadless);
    // Missing stewardship never grants owners or admins implicit read access.
    for (const userId of [OWNER, ADMIN]) {
      const granted = await authorizedFor(database, {
        organizationId: ORG,
        userId,
      });
      expect(granted).not.toContain(memberless);
      expect(granted).not.toContain(externalOnly);
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
    await applyVisibility(database);

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
    await database.exec("BEGIN");
    await withPgliteWorkspaceCreation({
      database,
      rows: [
        {
          id: brandPersistedWorkspaceId(clientlessOrganizationMatter),
          organizationId: brandPersistedOrganizationId(ORG),
          name: "Organization matter",
          reference: clientlessOrganizationMatter,
          clientId: null,
          visibility: "admins_and_assigned",
          leadUserId: null,
        },
        {
          id: brandPersistedWorkspaceId(privateClientMatter),
          organizationId: brandPersistedOrganizationId(ORG),
          name: "Private client matter",
          reference: privateClientMatter,
          clientId: toSafeId<"contact">(CLIENT),
          visibility: "assigned_only",
          leadUserId: OTHER_MEMBER,
        },
      ],
      insert: async (normalized) => {
        const first = normalized.at(0) ?? panic("Missing organization matter");
        const second = normalized.at(1) ?? panic("Missing private matter");
        await database.query(
          "INSERT INTO workspaces (id,organization_id,client_id,visibility,lead_user_id) VALUES ($1,$2,$3,$4,$5),($6,$7,$8,$9,$10)",
          [
            first.id,
            first.organizationId,
            first.clientId,
            first.visibility,
            first.leadUserId,
            second.id,
            second.organizationId,
            second.clientId,
            second.visibility,
            second.leadUserId,
          ],
        );
        await database.query(
          "INSERT INTO workspace_members (id,workspace_id,user_id) VALUES ('wm4',$1,$2)",
          [second.id, second.leadUserId],
        );
      },
    });
    await database.exec("COMMIT");

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

  test("a writer that omits visibility gets the visibility the old rule implied, with its creator as lead", async () => {
    await using database = await migrated();
    // Without a usable creator, clientless creation is refused.
    const missingCreatorId = brandPersistedWorkspaceId(
      "00000000-0000-4000-8000-0000000000a5",
    );
    const missingCreator = await Result.tryPromise({
      try: async () => {
        await database.exec("BEGIN");
        await withPgliteWorkspaceCreation({
          database,
          rows: [
            {
              id: missingCreatorId,
              organizationId: brandPersistedOrganizationId(ORG),
              name: "Missing creator",
              reference: missingCreatorId,
              visibility: "assigned_only",
              leadUserId: null,
            },
          ],
          insert: async (normalized) => {
            const row = normalized.at(0) ?? panic("Missing creation row");
            await database.query(
              "INSERT INTO workspaces (id,organization_id,client_id) VALUES ($1,$2,NULL)",
              [row.id, row.organizationId],
            );
          },
        });
        await database.exec("COMMIT");
      },
      catch: (error) => error,
    });
    expect(missingCreator).toMatchObject({
      status: "error",
      error: { code: "23514" },
    });
    await database.exec("ROLLBACK");
    await database.query("SELECT set_config('app.user_id', $1, false)", [
      MEMBER,
    ]);
    await database.exec("BEGIN");
    const legacyIds = [
      "00000000-0000-4000-8000-0000000000a1",
      "00000000-0000-4000-8000-0000000000a2",
      "00000000-0000-4000-8000-0000000000a3",
      "00000000-0000-4000-8000-0000000000a4",
    ].map(brandPersistedWorkspaceId);
    await withPgliteWorkspaceCreation({
      database,
      rows: legacyIds.map((id) => ({
        id,
        organizationId: brandPersistedOrganizationId(ORG),
        name: "Legacy writer",
        reference: id,
        visibility: "assigned_only",
        leadUserId: MEMBER,
      })),
      insert: async (normalized) => {
        const first = normalized.at(0) ?? panic("Missing legacy matter");
        const second = normalized.at(1) ?? panic("Missing legacy matter");
        const third = normalized.at(2) ?? panic("Missing legacy matter");
        const fourth = normalized.at(3) ?? panic("Missing legacy matter");
        await database.query(
          "INSERT INTO workspaces (id,organization_id,client_id) VALUES ($1,$2,NULL),($3,$2,$4)",
          [first.id, first.organizationId, second.id, CLIENT],
        );
        await database.query(
          "INSERT INTO workspaces (id,organization_id,client_id,visibility) VALUES ($1,$2,NULL,'all_members'),($3,$2,$4,'admins_and_assigned')",
          [third.id, third.organizationId, fourth.id, CLIENT],
        );
        await database.query(
          "UPDATE workspaces SET lead_user_id=$1 WHERE id=$2",
          [fourth.leadUserId, fourth.id],
        );
        await database.query(
          "INSERT INTO workspace_members (id,workspace_id,user_id) VALUES ('legacy_created1',$1,$3),('legacy_created4',$2,$3)",
          [first.id, fourth.id, first.leadUserId],
        );
      },
    });
    await database.exec("COMMIT");
    // Explicit narrowing is a new writer operation, distinct from legacy INSERT.
    await database.exec("BEGIN");
    await lockStewardship(
      database,
      ["00000000-0000-4000-8000-0000000000a4"],
      [MEMBER],
    );
    await database.exec(`
      UPDATE workspaces SET visibility = 'assigned_only' WHERE id = '00000000-0000-4000-8000-0000000000a4';
      COMMIT;
    `);

    const visibility = await visibilityById(database);
    expect(visibility["00000000-0000-4000-8000-0000000000a1"]).toBe(
      "assigned_only",
    );
    expect(visibility["00000000-0000-4000-8000-0000000000a2"]).toBe(
      "admins_and_assigned",
    );
    expect(visibility["00000000-0000-4000-8000-0000000000a5"]).toBeUndefined();
    const { rows } = await database.query<{ lead: string | null }>(
      "SELECT lead_user_id AS lead FROM workspaces WHERE id = '00000000-0000-4000-8000-0000000000a1'",
    );
    expect(rows.at(0)?.lead).toBe(MEMBER);
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

    await database.exec("BEGIN");
    expect(
      await rejectionOf(
        withPgliteWorkspaceCreation({
          database,
          rows: [
            {
              id: brandPersistedWorkspaceId(
                "00000000-0000-4000-8000-0000000000b1",
              ),
              organizationId: brandPersistedOrganizationId(ORG),
              name: "Invalid visibility",
              reference: "invalid",
              visibility: "assigned_only",
              leadUserId: null,
            },
          ],
          insert: async (normalized) => {
            const row =
              normalized.at(0) ?? panic("Missing invalid creation row");
            await database.query(
              "INSERT INTO workspaces (id,organization_id,visibility) VALUES ($1,$2,'public')",
              [row.id, row.organizationId],
            );
          },
        }),
      ),
    ).toMatchObject({ constraint: "workspaces_visibility_check" });
    await database.exec("ROLLBACK");
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

  test("a member who leads an assigned-only matter keeps an internal role; anyone else may change", async () => {
    await using database = await migrated();

    // MEMBER leads the assigned-only clientlessOfMember matter.
    await database.exec("BEGIN");
    await lockStewardship(database, [MATTER.clientlessOfMember], [MEMBER]);
    expect(
      String(
        await rejectionOf(
          database.exec(
            `UPDATE member SET role = 'external' WHERE user_id = '${MEMBER}' AND organization_id = '${ORG}'`,
          ),
        ),
      ),
    ).toMatch(/member_role_keeps_matter_leads|leads a matter/u);
    await database.exec("ROLLBACK");
    await database.exec("BEGIN");
    await lockStewardship(database, [MATTER.clientlessOfMember], [MEMBER]);
    // Another internal role keeps the lead usable.
    await database.exec(
      `UPDATE member SET role = 'intern' WHERE user_id = '${MEMBER}' AND organization_id = '${ORG}'`,
    );
    // Once the matter is no longer assigned-only, the role is free.
    await database.exec(
      `UPDATE workspaces SET visibility = 'admins_and_assigned' WHERE id = '${MATTER.clientlessOfMember}'`,
    );
    await database.exec(
      `UPDATE member SET role = 'external' WHERE user_id = '${MEMBER}' AND organization_id = '${ORG}'`,
    );
    await database.exec("COMMIT");
    const { rows } = await database.query<{ role: string }>(
      `SELECT role FROM member WHERE user_id = '${MEMBER}' AND organization_id = '${ORG}'`,
    );
    expect(rows).toEqual([{ role: "external" }]);
  });
});
