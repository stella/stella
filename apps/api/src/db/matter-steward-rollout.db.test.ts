import { PGlite } from "@electric-sql/pglite";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { getColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { MATTER_VISIBILITY } from "@stll/api-contract/matter-visibility";
import type { Verdict } from "@stll/db-load-gate/health";
import { INTERNAL_MEMBER_ROLES, roles } from "@stll/permissions";

import { auditLogs } from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import {
  withLegacyWorkspaceFixture,
  withPgliteWorkspaceCreation,
} from "@/api/tests/helpers/workspace-creation";

import { createMatterVisibilityRepair } from "./matter-visibility-repair";
import { createUngatedTableGateForTests } from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";

/** Legacy mutation statements must preserve assigned-only matter stewardship. */

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20261029072000_matter_visibility/migration.sql",
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
  await database.exec(
    `CREATE TABLE audit_logs (${Object.values(getColumns(auditLogs))
      .map(
        (column) =>
          `"${column.name}" ${column.getSQLType()}${column.name === "created_at" ? " DEFAULT now()" : ""}`,
      )
      .join(", ")})`,
  );
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

// These orders mirror the handlers deployed before the stewardship prefix.
const legacyRemovalSql = ({
  kind,
  matter,
  departing,
}: {
  kind: "matter" | "organization";
  matter: string;
  departing: string;
}) => {
  if (kind === "organization") {
    return `
      UPDATE workspaces SET lead_user_id = NULL
        WHERE organization_id = '${ORG}' AND lead_user_id = '${departing}';
      DELETE FROM workspace_members wm USING workspaces w
        WHERE wm.workspace_id = w.id AND w.organization_id = '${ORG}'
          AND wm.user_id = '${departing}';
      DELETE FROM member WHERE organization_id = '${ORG}' AND user_id = '${departing}';
    `;
  }
  return `
    SELECT id FROM workspaces WHERE id = '${matter}' FOR UPDATE;
    SELECT id FROM workspace_members WHERE workspace_id = '${matter}' FOR UPDATE;
    DELETE FROM workspace_members WHERE workspace_id = '${matter}' AND user_id = '${departing}';
    UPDATE workspaces SET lead_user_id = NULL
      WHERE id = '${matter}' AND lead_user_id = '${departing}';
  `;
};

const rejectedMutations = [
  {
    name: "legacy matter removal deletes the lead assignment before clearing the lead",
    statement: legacyRemovalSql({
      kind: "matter",
      matter: MATTER.clientlessOfMember,
      departing: MEMBER,
    }),
  },
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

  test.each(["restricted", "owner"] as const)(
    "%s preflight treats foreign and absent matter IDs alike without locking foreign rows",
    async (caller) => {
      await using database = await migrated();
      const foreignRows = async () => ({
        matters: (
          await database.query(
            "SELECT id, xmax::text AS lock_version FROM workspaces WHERE organization_id = $1 ORDER BY id",
            [OTHER_ORG],
          )
        ).rows,
        members: (
          await database.query(
            "SELECT id, xmax::text AS lock_version FROM member WHERE organization_id = $1 ORDER BY id",
            [OTHER_ORG],
          )
        ).rows,
      });
      for (const workspaceId of [
        MATTER.otherOrgClientMatter,
        "00000000-0000-4000-8000-000000000099",
      ]) {
        await database.exec("BEGIN");
        const before = await foreignRows();
        if (caller === "restricted") {
          await database.exec("SET LOCAL ROLE stella");
        }
        await database.query(
          "SELECT set_config('app.organization_id', $1, true)",
          [ORG],
        );
        const result = await database.query(
          "SELECT count(*)::integer AS requested_count FROM public.stella_lock_matter_stewardship($1::text::jsonb, 'update')",
          [
            JSON.stringify([
              {
                organization_id: ORG,
                workspace_ids: [workspaceId],
                user_ids: [OWNER],
                membership_user_ids: [],
              },
            ]),
          ],
        );
        expect(result.rows).toEqual([{ requested_count: 1 }]);
        await database.exec("RESET ROLE");
        // Heap xmax changes on a row-lock acquisition even when no values change.
        expect(await foreignRows()).toEqual(before);
        const proof = await database.query(
          "SELECT proof->'members' AS members FROM public.matter_stewardship_locks WHERE transaction_id = txid_current()",
        );
        expect(proof.rows).toEqual([{ members: ["m1"] }]);
        await database.exec("ROLLBACK");
      }
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

  for (const visibility of [
    MATTER_VISIBILITY.adminsAndAssigned,
    MATTER_VISIBILITY.allMembers,
  ]) {
    test.each(["matter", "organization"] as const)(
      `legacy %s removal preserves nonprivate ${visibility} access`,
      async (kind) => {
        await using database = new PGlite();
        await seed(database);
        await database.exec(`
          UPDATE workspaces SET lead_user_id = '${ADMIN}' WHERE id = '${MATTER.clientMatter}';
          INSERT INTO workspace_members VALUES ('legacy_admin', '${MATTER.clientMatter}', '${ADMIN}');
        `);
        await applyVisibility(database);
        await database.exec("BEGIN");
        await lockStewardship(database, [MATTER.clientMatter], [ADMIN]);
        await database.query(
          "UPDATE workspaces SET visibility = $1 WHERE id = $2",
          [visibility, MATTER.clientMatter],
        );
        await database.exec("COMMIT; BEGIN");
        await database.exec(
          legacyRemovalSql({
            kind,
            matter: MATTER.clientMatter,
            departing: ADMIN,
          }),
        );
        await database.exec("COMMIT");
        expect(
          (
            await database.query(
              "SELECT lead_user_id, visibility FROM workspaces WHERE id = $1",
              [MATTER.clientMatter],
            )
          ).rows,
        ).toEqual([{ lead_user_id: null, visibility }]);
        expect(
          (
            await database.query(
              "SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
              [MATTER.clientMatter, ADMIN],
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await database.query(
              "SELECT id FROM member WHERE organization_id = $1 AND user_id = $2",
              [ORG, ADMIN],
            )
          ).rows,
        ).toEqual(kind === "organization" ? [] : [{ id: "m2" }]);
        await assertUsableSteward(database);
      },
    );
  }

  test.each([
    { kind: "matter", departing: EXTERNAL },
    { kind: "organization", departing: EXTERNAL },
    { kind: "matter", departing: OWNER },
    { kind: "organization", departing: OWNER },
  ] as const)(
    "legacy $kind removal of private nonlead $departing preserves its usable steward",
    async ({ kind, departing }) => {
      await using database = await migrated();
      await database.exec("BEGIN");
      await database.exec(
        legacyRemovalSql({
          kind,
          matter: MATTER.clientlessOfMember,
          departing,
        }),
      );
      await database.exec("COMMIT");
      expect(
        (
          await database.query(
            "SELECT lead_user_id, visibility FROM workspaces WHERE id = $1",
            [MATTER.clientlessOfMember],
          )
        ).rows,
      ).toEqual([
        { lead_user_id: MEMBER, visibility: MATTER_VISIBILITY.assignedOnly },
      ]);
      expect(
        (
          await database.query(
            "SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
            [MATTER.clientlessOfMember, departing],
          )
        ).rows,
      ).toEqual([]);
      await assertUsableSteward(database);
    },
  );

  for (const orphan of ["external-only", "unassigned"] as const) {
    test.each(["matter", "organization"] as const)(
      `legacy %s removal unrelated to a migrated ${orphan} orphan remains possible`,
      async (kind) => {
        await using database = new PGlite();
        await seed(database);
        await database.exec(`
          DELETE FROM workspace_members WHERE workspace_id = '${MATTER.clientlessOfMember}'
            ${orphan === "external-only" ? `AND user_id IN ('${MEMBER}', '${OWNER}')` : ""};
          UPDATE workspaces SET lead_user_id = NULL
            WHERE id = '${MATTER.clientlessOfMember}';
        `);
        await applyVisibility(database);
        const expected = [
          { lead_user_id: null, visibility: MATTER_VISIBILITY.assignedOnly },
        ];
        expect(
          (
            await database.query(
              "SELECT lead_user_id, visibility FROM workspaces WHERE id = $1",
              [MATTER.clientlessOfMember],
            )
          ).rows,
        ).toEqual(expected);
        await database.exec("BEGIN");
        await database.exec(
          legacyRemovalSql({
            kind,
            matter: MATTER.clientlessOfMember,
            departing: EXTERNAL,
          }),
        );
        await database.exec("COMMIT");
        expect(
          (
            await database.query(
              "SELECT lead_user_id, visibility FROM workspaces WHERE id = $1",
              [MATTER.clientlessOfMember],
            )
          ).rows,
        ).toEqual(expected);
        expect(
          (
            await database.query(
              "SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
              [MATTER.clientlessOfMember, EXTERNAL],
            )
          ).rows,
        ).toEqual([]);
      },
    );
  }

  test.each([
    { kind: "matter", departing: EXTERNAL },
    { kind: "organization", departing: EXTERNAL },
    { kind: "matter", departing: MEMBER },
    { kind: "organization", departing: MEMBER },
  ] as const)(
    "legacy $kind removal clears preserved unusable lead $departing without changing visibility",
    async ({ kind, departing }) => {
      await using database = new PGlite();
      await seed(database);
      await database.exec(`
        DELETE FROM workspace_members WHERE workspace_id = '${MATTER.clientlessOfMember}'
          AND user_id IN ('${MEMBER}', '${OWNER}');
        UPDATE workspaces SET lead_user_id = '${departing}' WHERE id = '${MATTER.clientlessOfMember}';
      `);
      await applyVisibility(database);
      expect(
        (
          await database.query(
            "SELECT lead_user_id, visibility FROM workspaces WHERE id = $1",
            [MATTER.clientlessOfMember],
          )
        ).rows,
      ).toEqual([
        { lead_user_id: departing, visibility: MATTER_VISIBILITY.assignedOnly },
      ]);
      await database.exec("BEGIN");
      await database.exec(
        legacyRemovalSql({
          kind,
          matter: MATTER.clientlessOfMember,
          departing,
        }),
      );
      await database.exec("COMMIT");
      expect(
        (
          await database.query(
            "SELECT lead_user_id, visibility FROM workspaces WHERE id = $1",
            [MATTER.clientlessOfMember],
          )
        ).rows,
      ).toEqual([
        { lead_user_id: null, visibility: MATTER_VISIBILITY.assignedOnly },
      ]);
      expect(
        (
          await database.query(
            "SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
            [MATTER.clientlessOfMember, departing],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await database.query(
            "SELECT id FROM member WHERE organization_id = $1 AND user_id = $2",
            [ORG, departing],
          )
        ).rows,
      ).toEqual(
        kind === "organization"
          ? []
          : [{ id: departing === EXTERNAL ? "m6" : "m3" }],
      );
    },
  );

  test.each(["user", "service"] as const)(
    "legacy lead cleanup records one transactional scoped audit with %s attribution",
    async (actor) => {
      await using database = new PGlite();
      await seed(database);
      await database.exec(`
        DELETE FROM workspace_members WHERE workspace_id = '${MATTER.clientlessOfMember}'
          AND user_id IN ('${MEMBER}', '${OWNER}');
        UPDATE workspaces SET lead_user_id = '${EXTERNAL}' WHERE id = '${MATTER.clientlessOfMember}';
      `);
      await applyVisibility(database);
      const before = await matterSnapshot(database);
      const audits = async () =>
        (
          await database.query(
            "SELECT to_jsonb(a) - 'id' - 'group_id' - 'created_at' AS event FROM audit_logs a ORDER BY created_at, id",
          )
        ).rows;
      const remove = async () => {
        await database.exec("BEGIN");
        await database.query("SELECT set_config('app.user_id', $1, true)", [
          actor === "user" ? ADMIN : "",
        ]);
        await database.exec(
          legacyRemovalSql({
            kind: "matter",
            matter: MATTER.clientlessOfMember,
            departing: EXTERNAL,
          }),
        );
      };
      await remove();
      expect(await audits()).toHaveLength(1);
      await database.exec("ROLLBACK");
      expect(await matterSnapshot(database)).toEqual(before);
      expect(await audits()).toEqual([]);

      const identity =
        actor === "user" ? ADMIN : "system:matter-steward-compatibility";
      const recorder = createBackgroundAuditRecorder({
        organizationId: brandPersistedOrganizationId(ORG),
        workspaceId: brandPersistedWorkspaceId(MATTER.clientlessOfMember),
        userId: identity,
        execution:
          actor === "user"
            ? {
                performer: { type: "user", id: brandPersistedUserId(ADMIN) },
                trigger: { type: "direct" },
              }
            : {
                performer: {
                  type: "service",
                  id: identity,
                  name: "Matter stewardship compatibility",
                },
                trigger: {
                  type: "system",
                  source: "matter-steward-compatibility",
                },
              },
      });
      await drizzle({ client: database }).transaction(async (tx) => {
        await recorder(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
          resourceId: MATTER.clientlessOfMember,
          changes: { leadUserId: { old: EXTERNAL, new: null } },
          metadata: { cause: "matter_steward_cleared" },
        });
      });
      const expected = await audits();
      await database.exec("DELETE FROM audit_logs");

      await remove();
      await database.exec("COMMIT");
      expect(await audits()).toEqual(expected);
      expect(
        (
          await database.query(
            "SELECT lead_user_id, visibility FROM workspaces WHERE id = $1",
            [MATTER.clientlessOfMember],
          )
        ).rows,
      ).toEqual([
        { lead_user_id: null, visibility: MATTER_VISIBILITY.assignedOnly },
      ]);
      await database.query(
        "UPDATE workspaces SET lead_user_id = NULL WHERE id = $1",
        [MATTER.clientlessOfMember],
      );
      expect(await audits()).toEqual(expected);
    },
  );

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
    { label: "null", lead: null, assigned: false, transition: "retain" },
    { label: "external", lead: EXTERNAL, assigned: true, transition: "retain" },
    {
      label: "unassigned internal",
      lead: MEMBER,
      assigned: false,
      transition: "retain",
    },
    {
      label: "assigned internal",
      lead: MEMBER,
      assigned: true,
      transition: "retain",
    },
    {
      label: "cleared before assignment",
      lead: MEMBER,
      assigned: true,
      transition: "clear",
    },
  ])(
    "deferred INSERT validation: $label lead",
    async ({ lead, assigned, transition }) => {
      await using database = await migrated();
      const id = "00000000-0000-4000-8000-0000000000a8";
      await database.exec("BEGIN");
      await withPgliteWorkspaceCreation({
        database,
        rows: [
          {
            id: brandPersistedWorkspaceId(id),
            organizationId: brandPersistedOrganizationId(ORG),
            name: "Deferred matter",
            reference: id,
            visibility: "assigned_only",
            leadUserId: lead,
          },
        ],
        insert: async (normalized) => {
          const row = normalized.at(0) ?? panic("Missing creation row");
          await database.query(
            "INSERT INTO workspaces (id,organization_id,lead_user_id,visibility) VALUES ($1,$2,$3,$4)",
            [row.id, row.organizationId, row.leadUserId, row.visibility],
          );
        },
      });
      if (transition === "clear") {
        await database.query(
          "UPDATE workspaces SET lead_user_id = NULL WHERE id = $1",
          [id],
        );
      }
      if (assigned) {
        await database.query(
          "INSERT INTO workspace_members (id,workspace_id,user_id) VALUES ('new_assignment',$1,$2)",
          [id, lead],
        );
      }
      const commit = await Result.tryPromise({
        try: async () => await database.exec("COMMIT"),
        catch: (error) => error,
      });
      expect(commit.isOk()).toBe(
        lead === MEMBER && assigned && transition === "retain",
      );
      if (transition === "clear") {
        expect(commit).toMatchObject({
          status: "error",
          error: { code: "23514" },
        });
      }
      if (commit.isErr()) {
        await database.exec("ROLLBACK");
      }
      expect(
        (await database.query("SELECT id FROM workspaces WHERE id = $1", [id]))
          .rows,
      ).toHaveLength(commit.isOk() ? 1 : 0);
      if (transition === "clear") {
        expect(
          (
            await database.query(
              "SELECT id FROM workspace_members WHERE workspace_id = $1",
              [id],
            )
          ).rows,
        ).toEqual([]);
      }
    },
  );
});
