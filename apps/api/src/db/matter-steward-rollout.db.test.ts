import { PGlite } from "@electric-sql/pglite";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import type { Verdict } from "@stll/db-load-gate/health";
import { INTERNAL_MEMBER_ROLES, roles } from "@stll/permissions";

import { createMatterVisibilityRepair } from "./matter-visibility-repair";
import type { OnlineMigrationConnection } from "./online-migration-connection";

/** Legacy mutation statements must preserve assigned-only matter stewardship. */

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
CREATE ROLE stella;
CREATE TABLE organization (id text PRIMARY KEY);
CREATE TABLE "user" (id text PRIMARY KEY);
CREATE TABLE member (
  id text PRIMARY KEY,
  organization_id varchar(128) NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL
);
CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  organization_id varchar(128) NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  client_id uuid,
  lead_user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active'
);
CREATE TABLE workspace_members (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
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
  await database.exec(`
    INSERT INTO organization VALUES ('${ORG}'), ('${OTHER_ORG}');
    INSERT INTO "user" VALUES ('${OWNER}'), ('${ADMIN}'), ('${MEMBER}'),
      ('${OTHER_MEMBER}'), ('${EXTERNAL}'), ('${INTERN}'), ('foreign_user');
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
      ('wm3', '${MATTER.clientMatter}', '${MEMBER}'),
      ('wm4', '${MATTER.clientlessOfMember}', '${EXTERNAL}'),
      ('wm5', '${MATTER.clientlessOfMember}', '${OWNER}');
  `);
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
  await repair.repair(connectionOver(database));
};

const migrated = async (): Promise<PGlite> => {
  const database = new PGlite();
  await seed(database);
  await applyVisibility(database);
  return database;
};

const matterSnapshot = async (database: PGlite) => ({
  matters: (await database.query("SELECT * FROM workspaces ORDER BY id")).rows,
  assignments: (
    await database.query("SELECT * FROM workspace_members ORDER BY id")
  ).rows,
  members: (await database.query("SELECT * FROM member ORDER BY id")).rows,
});

const assertUsableSteward = async (database: PGlite) => {
  const result = await database.query<{ usable: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM workspace_members wm
      JOIN member m ON m.user_id = wm.user_id AND m.organization_id = w.organization_id
      WHERE wm.workspace_id = w.id AND wm.user_id = w.lead_user_id
        AND m.role IN ('owner', 'admin', 'member', 'intern')
    ) AS usable
    FROM workspaces w WHERE w.id = '${MATTER.clientlessOfMember}'
  `);
  expect(result.rows).toEqual([{ usable: true }]);
};

const rejectedMutations = [
  {
    name: "a matter without a lead narrows to assigned-only",
    statement: `UPDATE workspaces SET visibility = 'assigned_only' WHERE id = '${MATTER.clientMatter}'`,
  },
  {
    name: "the lead assignment changes user identity",
    statement: `UPDATE workspace_members SET user_id = '${ADMIN}'
      WHERE workspace_id = '${MATTER.clientlessOfMember}' AND user_id = '${MEMBER}'`,
  },
  {
    name: "the lead assignment moves to another matter",
    statement: `UPDATE workspace_members SET workspace_id = '${MATTER.clientlessOfOther}'
      WHERE workspace_id = '${MATTER.clientlessOfMember}' AND user_id = '${MEMBER}'`,
  },
  {
    name: "the lead organization membership changes user identity",
    statement: `UPDATE member SET user_id = '${ADMIN}'
      WHERE user_id = '${MEMBER}' AND organization_id = '${ORG}'`,
  },
  {
    name: "the lead organization membership moves to another organization",
    statement: `UPDATE member SET organization_id = '${OTHER_ORG}'
      WHERE user_id = '${MEMBER}' AND organization_id = '${ORG}'`,
  },
  {
    name: "legacy offboarding clears the lead before removing assignments",
    statement: `
      UPDATE workspaces SET lead_user_id = NULL WHERE lead_user_id = '${MEMBER}';
      DELETE FROM workspace_members WHERE user_id = '${MEMBER}';
      DELETE FROM member WHERE user_id = '${MEMBER}' AND organization_id = '${ORG}';
    `,
  },
  {
    name: "the lead assignment is removed directly",
    statement: `DELETE FROM workspace_members
      WHERE workspace_id = '${MATTER.clientlessOfMember}' AND user_id = '${MEMBER}'`,
  },
  {
    name: "the lead organization membership is removed directly",
    statement: `DELETE FROM member WHERE user_id = '${MEMBER}' AND organization_id = '${ORG}'`,
  },
  {
    name: "the lead changes to an unassigned internal member",
    statement: `UPDATE workspaces SET lead_user_id = '${ADMIN}' WHERE id = '${MATTER.clientlessOfMember}'`,
  },
  {
    name: "the lead changes to an assigned external member",
    statement: `UPDATE workspaces SET lead_user_id = '${EXTERNAL}' WHERE id = '${MATTER.clientlessOfMember}'`,
  },
  {
    name: "the lead changes to a member of another organization",
    statement: `UPDATE workspaces SET lead_user_id = 'foreign_user' WHERE id = '${MATTER.clientlessOfMember}'`,
  },
  {
    name: "the lead changes to a missing user",
    statement: `UPDATE workspaces SET lead_user_id = 'missing_user' WHERE id = '${MATTER.clientlessOfMember}'`,
  },
  {
    name: "the assigned lead becomes external",
    statement: `UPDATE member SET role = 'external' WHERE user_id = '${MEMBER}' AND organization_id = '${ORG}'`,
  },
];

describe("assigned-only matter stewardship across mutation entry points", () => {
  test("stewardship triggers validate the prefix without acquiring row or advisory locks", () => {
    const functions = [
      ...migrationSql.matchAll(
        /CREATE(?: OR REPLACE)? FUNCTION\s+([^\s(]+)[\s\S]*?AS \$\$([\s\S]*?)\$\$/gu,
      ),
    ];
    const guards = functions.filter(([, name]) =>
      name?.replaceAll('"', "").replace("public.", "").startsWith("enforce_"),
    );
    expect(guards).toHaveLength(4);
    for (const guard of guards) {
      expect(guard.at(2)).not.toMatch(
        /FOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)|pg_advisory_(?:xact_)?lock\s*\(/iu,
      );
    }
    const owner = functions.find(
      ([, name]) => name === "public.stella_lock_matter_stewardship",
    );
    expect(owner?.at(2)).toMatch(/FOR NO KEY UPDATE/u);
    expect(owner?.at(2)).toMatch(/FOR SHARE/u);
    expect(owner?.at(2)).toMatch(/pg_advisory_xact_lock/u);
  });

  test("restricted sessions cannot forge stewardship completion after an empty canonical call", async () => {
    await using database = await migrated();
    const before = await matterSnapshot(database);
    await database.exec("GRANT SELECT, UPDATE ON workspaces TO stella");
    await database.exec("BEGIN; SET LOCAL ROLE stella");
    await database.query("SELECT set_config('app.organization_id', $1, true)", [
      ORG,
    ]);
    await database.query(
      "SELECT public.stella_lock_matter_stewardship('[]'::jsonb, 'update')",
    );
    await database.query(
      "SELECT set_config('stella.stewardship_locks', $1, true)",
      [
        JSON.stringify({
          mode: "update",
          workspaces: [MATTER.clientlessOfMember],
          members: ["m3"],
        }),
      ],
    );
    const forged = await Result.tryPromise({
      try: async () =>
        await database.query(
          "UPDATE workspaces SET lead_user_id = NULL WHERE id = $1",
          [MATTER.clientlessOfMember],
        ),
      catch: (error) => error,
    });
    expect(forged).toMatchObject({ status: "error", error: { code: "55P03" } });
    await database.exec("ROLLBACK");
    expect(await matterSnapshot(database)).toEqual(before);
  });

  test("restricted sessions cannot write the protected stewardship proof table", async () => {
    await using database = await migrated();
    await database.exec("BEGIN; SET LOCAL ROLE stella");
    const forged = await Result.tryPromise({
      try: async () =>
        await database.exec(
          "INSERT INTO public.matter_stewardship_locks(transaction_id, proof) VALUES (txid_current(), '{}'::jsonb)",
        ),
      catch: (error) => error,
    });
    expect(forged).toMatchObject({ status: "error", error: { code: "42501" } });
    await database.exec("ROLLBACK");
  });

  test.each([
    {
      name: "another organization",
      organizationId: OTHER_ORG,
      workspaceIds: [MATTER.otherOrgClientMatter],
      membershipUserIds: [],
    },
    {
      name: "another organization's matter under the local organization",
      organizationId: ORG,
      workspaceIds: [MATTER.otherOrgClientMatter],
      membershipUserIds: [],
    },
    {
      name: "membership-wide discovery",
      organizationId: ORG,
      workspaceIds: [],
      membershipUserIds: [MEMBER],
    },
  ])(
    "restricted sessions cannot request $name",
    async ({ organizationId, workspaceIds, membershipUserIds }) => {
      await using database = await migrated();
      const before = await matterSnapshot(database);
      await database.exec("BEGIN; SET LOCAL ROLE stella");
      await database.query(
        "SELECT set_config('app.organization_id', $1, true)",
        [ORG],
      );
      const refused = await Result.tryPromise({
        try: async () =>
          await database.query(
            "SELECT public.stella_lock_matter_stewardship($1::text::jsonb, 'update')",
            [
              JSON.stringify([
                {
                  organization_id: organizationId,
                  workspace_ids: workspaceIds,
                  user_ids: [],
                  membership_user_ids: membershipUserIds,
                },
              ]),
            ],
          ),
        catch: (error) => error,
      });
      expect(refused).toMatchObject({
        status: "error",
        error: { code: "42501" },
      });
      await database.exec("ROLLBACK");
      expect(await matterSnapshot(database)).toEqual(before);
    },
  );

  test("restricted sessions cannot invoke the migration repair", async () => {
    await using database = await migrated();
    const before = await matterSnapshot(database);
    await database.exec("BEGIN; SET LOCAL ROLE stella");
    await database.query("SELECT set_config('app.organization_id', $1, true)", [
      ORG,
    ]);
    const refused = await Result.tryPromise({
      try: async () =>
        await database.query(
          "SELECT public.stella_repair_legacy_visibility_batch($1::uuid[])",
          [[MATTER.clientlessOfMember]],
        ),
      catch: (error) => error,
    });
    expect(refused).toMatchObject({
      status: "error",
      error: { code: "42501" },
    });
    await database.exec("ROLLBACK");
    expect(await matterSnapshot(database)).toEqual(before);
  });

  for (const role of Object.keys(roles)) {
    test(`assigned same-organization ${role} stewardship matches the internal role policy`, async () => {
      await using database = await migrated();
      await database.exec("BEGIN");
      await lockStewardship(database, [MATTER.clientlessOfMember], [EXTERNAL]);
      await database.query(
        "UPDATE member SET role = $1 WHERE user_id = $2 AND organization_id = $3",
        [role, EXTERNAL, ORG],
      );
      await database.exec("COMMIT");
      const before = await matterSnapshot(database);
      await database.exec("BEGIN");
      await lockStewardship(database, [MATTER.clientlessOfMember], [EXTERNAL]);
      const outcome = await Result.tryPromise(
        async () =>
          await database.query(
            "UPDATE workspaces SET lead_user_id = $1 WHERE id = $2",
            [EXTERNAL, MATTER.clientlessOfMember],
          ),
      );
      await database.exec(outcome.isOk() ? "COMMIT" : "ROLLBACK");
      const maySteward = INTERNAL_MEMBER_ROLES.some(
        (internalRole) => internalRole === role,
      );
      expect(outcome.isOk()).toBe(maySteward);
      if (outcome.isErr()) {
        expect(outcome.error.message).toMatch(/steward|lead|assigned/u);
        expect(await matterSnapshot(database)).toEqual(before);
      } else {
        const matter = await database.query<{ lead_user_id: string }>(
          "SELECT lead_user_id FROM workspaces WHERE id = $1",
          [MATTER.clientlessOfMember],
        );
        expect(matter.rows).toEqual([{ lead_user_id: EXTERNAL }]);
      }
      await assertUsableSteward(database);
    });
  }

  for (const deletion of ["matter", "organization"] as const) {
    test(`allows ${deletion} deletion to cascade through steward rows`, async () => {
      await using database = await migrated();
      if (deletion === "matter") {
        await database.query("DELETE FROM workspaces WHERE id = $1", [
          MATTER.clientlessOfMember,
        ]);
      } else {
        await database.query("DELETE FROM organization WHERE id = $1", [ORG]);
      }
      const matter = await database.query(
        "SELECT id FROM workspaces WHERE id = $1",
        [MATTER.clientlessOfMember],
      );
      expect(matter.rows).toEqual([]);
      const assignments = await database.query(
        "SELECT id FROM workspace_members WHERE workspace_id = $1",
        [MATTER.clientlessOfMember],
      );
      expect(assignments.rows).toEqual([]);
      const otherOrganization = await database.query(
        "SELECT id FROM workspaces WHERE id = $1",
        [MATTER.otherOrgClientMatter],
      );
      expect(otherOrganization.rows).toEqual([
        { id: MATTER.otherOrgClientMatter },
      ]);
    });
  }

  for (const { name, statement } of rejectedMutations) {
    test(`refuses mutation when ${name}`, async () => {
      await using database = await migrated();
      await database.exec("BEGIN");
      await lockStewardship(
        database,
        Object.values(MATTER).filter(
          (id) => id !== MATTER.otherOrgClientMatter,
        ),
        [OWNER, ADMIN, MEMBER, OTHER_MEMBER, EXTERNAL, INTERN],
      );
      await database.exec(`
        INSERT INTO member VALUES ('foreign_member', '${OTHER_ORG}', 'foreign_user', 'member');
        INSERT INTO workspace_members VALUES ('foreign_assignment', '${MATTER.clientlessOfMember}', 'foreign_user');
        COMMIT;
      `);
      await assertUsableSteward(database);
      const before = await matterSnapshot(database);
      await database.exec("BEGIN");
      const rejection = await database.exec(statement).then(
        () => undefined,
        (error: unknown) => error,
      );
      await database.exec("ROLLBACK");
      expect(String(rejection)).toMatch(/steward|lead|assigned/u);
      expect(await matterSnapshot(database)).toEqual(before);
      await assertUsableSteward(database);
    });
  }

  test("an assigned internal successor permits offboarding after the handoff", async () => {
    await using database = await migrated();
    await database.exec("BEGIN");
    await lockStewardship(
      database,
      Object.values(MATTER).filter((id) => id !== MATTER.otherOrgClientMatter),
      [OWNER, MEMBER],
    );
    await database.exec(`
      UPDATE workspaces SET lead_user_id = '${OWNER}' WHERE id = '${MATTER.clientlessOfMember}';
      DELETE FROM workspace_members WHERE user_id = '${MEMBER}';
      DELETE FROM member WHERE user_id = '${MEMBER}' AND organization_id = '${ORG}';
      COMMIT;
    `);
    await assertUsableSteward(database);
    const matter = await database.query<{
      lead_user_id: string;
      visibility: string;
    }>("SELECT lead_user_id, visibility FROM workspaces WHERE id = $1", [
      MATTER.clientlessOfMember,
    ]);
    expect(matter.rows).toEqual([
      { lead_user_id: OWNER, visibility: "assigned_only" },
    ]);
    const departing = await database.query(
      "SELECT id FROM member WHERE user_id = $1 AND organization_id = $2",
      [MEMBER, ORG],
    );
    expect(departing.rows).toEqual([]);
  });
  test("an unsupported private INSERT is refused before deferred validation", async () => {
    await using database = await migrated();
    const before = await matterSnapshot(database);
    const outcome = await Result.tryPromise({
      try: async () =>
        await database.query(
          "INSERT INTO workspaces (id,organization_id,lead_user_id,visibility) VALUES ('00000000-0000-4000-8000-0000000000a9',$1,$2,'assigned_only')",
          [ORG, MEMBER],
        ),
      catch: (error) => error,
    });
    expect(outcome).toMatchObject({
      status: "error",
      error: { code: "55P03" },
    });
    expect(await matterSnapshot(database)).toEqual(before);
  });

  test.each([
    { label: "null", lead: null, assigned: false },
    { label: "external", lead: EXTERNAL, assigned: true },
    { label: "unassigned internal", lead: MEMBER, assigned: false },
    { label: "assigned internal", lead: MEMBER, assigned: true },
  ])("deferred INSERT validation: $label lead", async ({ lead, assigned }) => {
    await using database = await migrated();
    const id = "00000000-0000-4000-8000-0000000000a8";
    await database.exec("BEGIN");
    await lockStewardship(database, [id], lead === null ? [] : [lead]);
    await database.query(
      "INSERT INTO workspaces (id,organization_id,lead_user_id,visibility) VALUES ($1,$2,$3,'assigned_only')",
      [id, ORG, lead],
    );
    if (assigned) {
      await database.query(
        "INSERT INTO workspace_members (id,workspace_id,user_id) VALUES ('new_assignment',$1,$2)",
        [id, lead],
      );
    }
    const commit = await Result.tryPromise(
      async () => await database.exec("COMMIT"),
    );
    expect(commit.isOk()).toBe(lead === MEMBER && assigned);
    if (commit.isErr()) {
      await database.exec("ROLLBACK");
    }
    expect(
      (await database.query("SELECT id FROM workspaces WHERE id = $1", [id]))
        .rows,
    ).toHaveLength(commit.isOk() ? 1 : 0);
  });
});
