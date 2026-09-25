import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import {
  agentSkillResources,
  agentSkillRevisions,
  agentSkills,
} from "@/api/db/schema";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type {
  TestDatabase,
  createScopedQuery,
} from "@/api/tests/security/test-utils";

const testId = <T extends SafeIdType>() => toSafeId<T>(Bun.randomUUIDv7());

let testDb: TestDatabase;
let ids: TestIds;
let scopedQuery: ReturnType<typeof createScopedQuery>;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedQuery = fixture.scopedQuery;
});

afterAll(async () => {
  await releaseRlsFixture();
});

describe("agent skill RLS", () => {
  test("private skills are visible only to their owner", async () => {
    const skillId = await insertSkill({
      organizationId: ids.orgA,
      scope: "private",
      slug: `private-${Bun.randomUUIDv7()}`,
      userId: ids.userA2,
    });

    const ownerCount = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) => tx.$count(agentSkills, eq(agentSkills.id, skillId)),
      ids.userA2,
    );
    const otherUserCount = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) => tx.$count(agentSkills, eq(agentSkills.id, skillId)),
      ids.userA1,
    );

    expect(ownerCount).toBe(1);
    expect(otherUserCount).toBe(0);
  });

  test("private skill resources are visible only to the skill owner", async () => {
    const skillId = await insertSkill({
      organizationId: ids.orgA,
      scope: "private",
      slug: `private-resource-${Bun.randomUUIDv7()}`,
      userId: ids.userA2,
    });
    const resourceId = await insertResource({
      organizationId: ids.orgA,
      path: "references/private.md",
      skillId,
    });

    const ownerCount = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) =>
        tx.$count(agentSkillResources, eq(agentSkillResources.id, resourceId)),
      ids.userA2,
    );
    const otherUserCount = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) =>
        tx.$count(agentSkillResources, eq(agentSkillResources.id, resourceId)),
      ids.userA1,
    );

    expect(ownerCount).toBe(1);
    expect(otherUserCount).toBe(0);
  });

  test("resource inserts require the referenced skill to belong to the same organization", async () => {
    const foreignSkillId = await insertSkill({
      organizationId: ids.orgB,
      scope: "team",
      slug: `foreign-${Bun.randomUUIDv7()}`,
      userId: ids.userB1,
    });

    const error = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      async (tx) =>
        await tryCatch(async () => {
          await tx.insert(agentSkillResources).values({
            id: testId(),
            organizationId: ids.orgA,
            skillId: foreignSkillId,
            path: "references/foreign.md",
            kind: "reference",
            content: "foreign",
            sizeBytes: 7,
          });
        }),
      ids.userA1,
    );

    expect(isPgError(error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
  });
});

const migrationPath = (name: string) =>
  nodePath.resolve(import.meta.dir, `../../../drizzle/${name}/migration.sql`);

const applyMigration = async (name: string) => {
  const statements = readFileSync(migrationPath(name), "utf-8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    await testDb.execute(sql.raw(statement));
  }
};

const readPolicies = async (policyNames: readonly string[]) =>
  await testDb.execute<{
    name: string;
    command: string;
    using: string | null;
    withCheck: string | null;
  }>(sql`
    SELECT
      polname AS name,
      polcmd AS command,
      pg_catalog.pg_get_expr(polqual, polrelid) AS using,
      pg_catalog.pg_get_expr(polwithcheck, polrelid) AS "withCheck"
    FROM pg_catalog.pg_policy
    WHERE polname IN (${sql.join(
      policyNames.map((name) => sql`${name}`),
      sql`, `,
    )})
    ORDER BY polname
  `);

describe("agent skill policy migrations", () => {
  test("the write policy migration leaves the policies as the schema declares them", async () => {
    const policyNames = [
      "agent_skill_insert",
      "agent_skill_update",
      "agent_skill_delete",
      "agent_skill_resource_insert",
      "agent_skill_resource_update",
      "agent_skill_resource_delete",
    ];
    const fromSchema = await readPolicies(policyNames);
    await applyMigration("20260925174000_agent_skill_write_policies");
    const migrated = await readPolicies(policyNames);

    expect(fromSchema.rows).toHaveLength(policyNames.length);
    expect(migrated.rows).toEqual(fromSchema.rows);
  });

  test("the revision lock migration creates the policy the schema declares", async () => {
    const policyNames = ["agent_skill_revision_lock"];
    const fromSchema = await readPolicies(policyNames);
    await testDb.execute(
      sql`DROP POLICY "agent_skill_revision_lock" ON "agent_skill_revisions"`,
    );
    await applyMigration("20260925174100_agent_skill_revision_lock_policy");
    const migrated = await readPolicies(policyNames);

    expect(fromSchema.rows).toHaveLength(1);
    expect(migrated.rows).toEqual(fromSchema.rows);
  });
});

// Postgres's check_violation SQLSTATE; no production path branches on it.
const CHECK_VIOLATION = "23514";

const DOMAIN_CHECKS = [
  { table: "agent_skills", constraint: "agent_skills_scope_check" },
  { table: "agent_skills", constraint: "agent_skills_origin_check" },
  {
    table: "agent_skill_resources",
    constraint: "agent_skill_resources_kind_check",
  },
] as const;

const readDomainChecks = async () =>
  await testDb.execute<{ name: string; definition: string }>(sql`
    SELECT
      conname AS name,
      pg_catalog.pg_get_constraintdef(oid) AS definition
    FROM pg_catalog.pg_constraint
    WHERE contype = 'c'
      AND conname IN (${sql.join(
        DOMAIN_CHECKS.map(({ constraint }) => sql`${constraint}`),
        sql`, `,
      )})
    ORDER BY conname
  `);

describe("agent skill domain values", () => {
  // The scope decides who may read and write a skill, so the database refuses
  // a value the application does not know rather than trusting every writer.
  test("an unknown scope, origin, or resource kind is refused", async () => {
    const skillId = await insertSkill({
      organizationId: ids.orgA,
      scope: "team",
      slug: `domain-${Bun.randomUUIDv7()}`,
      userId: ids.userAdmin,
    });
    const resourceId = await insertResource({
      organizationId: ids.orgA,
      path: "references/kind.md",
      skillId,
    });

    const errors = [
      await tryCatch(async () => {
        await testDb.execute(
          sql`UPDATE agent_skills SET scope = 'shared' WHERE id = ${skillId}`,
        );
      }),
      await tryCatch(async () => {
        await testDb.execute(
          sql`UPDATE agent_skills SET origin = 'mirror' WHERE id = ${skillId}`,
        );
      }),
      await tryCatch(async () => {
        await testDb.execute(
          sql`UPDATE agent_skill_resources SET kind = 'binary' WHERE id = ${resourceId}`,
        );
      }),
    ];

    expect(errors.map((error) => isPgError(error, CHECK_VIOLATION))).toEqual([
      true,
      true,
      true,
    ]);
  });

  test("the migration adds the checks the schema declares", async () => {
    const fromSchema = await readDomainChecks();
    for (const { table, constraint } of DOMAIN_CHECKS) {
      await testDb.execute(
        sql.raw(`ALTER TABLE "${table}" DROP CONSTRAINT "${constraint}"`),
      );
    }
    await applyMigration("20260925174200_agent_skill_domain_checks");
    const migrated = await readDomainChecks();

    expect(fromSchema.rows).toHaveLength(DOMAIN_CHECKS.length);
    expect(migrated.rows).toEqual(fromSchema.rows);
  });
});

describe("agent skill revision RLS", () => {
  test("a viewer may lock a revision but never update it", async () => {
    const skillId = await insertSkill({
      organizationId: ids.orgA,
      scope: "team",
      slug: `revision-lock-${Bun.randomUUIDv7()}`,
      userId: ids.userAdmin,
    });

    const locked = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      async (tx) =>
        await tx
          .select({ id: agentSkillRevisions.id })
          .from(agentSkillRevisions)
          .where(eq(agentSkillRevisions.skillId, skillId))
          .for("share"),
      ids.userA1,
    );
    const updateError = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      async (tx) =>
        await tryCatch(async () => {
          await tx
            .update(agentSkillRevisions)
            .set({ body: "rewritten" })
            .where(eq(agentSkillRevisions.skillId, skillId));
        }),
      ids.userAdmin,
    );

    expect(locked).toHaveLength(1);
    expect(isPgError(updateError, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
  });
});

describe("agent skill write RLS", () => {
  // Team skills are written by organization owners and admins, private skills
  // by their author. Every other member who can see a skill proposes and
  // comments instead, so the row itself refuses their writes.
  const writeCases = [
    { scope: "team", actor: "author", allowed: false },
    { scope: "team", actor: "member", allowed: false },
    { scope: "team", actor: "manager", allowed: true },
    { scope: "private", actor: "author", allowed: true },
    { scope: "private", actor: "member", allowed: false },
    { scope: "private", actor: "manager", allowed: false },
  ] as const;

  const actorId = (actor: (typeof writeCases)[number]["actor"]) => {
    switch (actor) {
      case "author":
        return ids.userA2;
      case "member":
        return ids.userA1;
      case "manager":
        return ids.userAdmin;
      default: {
        actor satisfies never;
        throw new TypeError("unknown actor");
      }
    }
  };

  test.each([...writeCases])(
    "$actor updating or deleting a $scope skill and its resources is allowed: $allowed",
    async ({ scope, actor, allowed }) => {
      const skillId = await insertSkill({
        organizationId: ids.orgA,
        scope,
        slug: `write-${Bun.randomUUIDv7()}`,
        userId: ids.userA2,
      });
      const resourceId = await insertResource({
        organizationId: ids.orgA,
        path: "references/write.md",
        skillId,
      });
      const expected = allowed ? 1 : 0;

      const updatedSkills = await scopedQuery(
        [ids.wsA1],
        ids.orgA,
        async (tx) =>
          await tx
            .update(agentSkills)
            .set({ description: "changed" })
            .where(eq(agentSkills.id, skillId))
            .returning({ id: agentSkills.id }),
        actorId(actor),
      );
      const updatedResources = await scopedQuery(
        [ids.wsA1],
        ids.orgA,
        async (tx) =>
          await tx
            .update(agentSkillResources)
            .set({ content: "changed" })
            .where(eq(agentSkillResources.id, resourceId))
            .returning({ id: agentSkillResources.id }),
        actorId(actor),
      );
      const deletedResources = await scopedQuery(
        [ids.wsA1],
        ids.orgA,
        async (tx) =>
          await tx
            .delete(agentSkillResources)
            .where(eq(agentSkillResources.id, resourceId))
            .returning({ id: agentSkillResources.id }),
        actorId(actor),
      );
      const insertError = await scopedQuery(
        [ids.wsA1],
        ids.orgA,
        async (tx) =>
          await tryCatch(async () => {
            await tx.insert(agentSkillResources).values({
              id: testId(),
              organizationId: ids.orgA,
              skillId,
              path: "references/added.md",
              kind: "reference",
              content: "added",
              sizeBytes: 5,
            });
          }),
        actorId(actor),
      );
      const deletedSkills = await scopedQuery(
        [ids.wsA1],
        ids.orgA,
        async (tx) =>
          await tx
            .delete(agentSkills)
            .where(eq(agentSkills.id, skillId))
            .returning({ id: agentSkills.id }),
        actorId(actor),
      );

      expect(updatedSkills).toHaveLength(expected);
      expect(updatedResources).toHaveLength(expected);
      expect(deletedResources).toHaveLength(expected);
      expect(deletedSkills).toHaveLength(expected);
      if (allowed) {
        expect(insertError).toBeNull();
      } else {
        expect(isPgError(insertError, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(
          true,
        );
      }
    },
  );

  test("only an owner or admin may create a team skill", async () => {
    const insertAs = async (userId: SafeId<"user">) =>
      await scopedQuery(
        [ids.wsA1],
        ids.orgA,
        async (tx) =>
          await tryCatch(async () => {
            await tx.insert(agentSkills).values(
              skillRow({
                organizationId: ids.orgA,
                scope: "team",
                slug: `team-create-${Bun.randomUUIDv7()}`,
                userId,
              }),
            );
          }),
        userId,
      );

    const memberError = await insertAs(ids.userA1);
    const managerError = await insertAs(ids.userAdmin);

    expect(isPgError(memberError, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
    expect(managerError).toBeNull();
  });

  test("a member may create a private skill of their own", async () => {
    const error = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      async (tx) =>
        await tryCatch(async () => {
          await tx.insert(agentSkills).values(
            skillRow({
              organizationId: ids.orgA,
              scope: "private",
              slug: `private-create-${Bun.randomUUIDv7()}`,
              userId: ids.userA1,
            }),
          );
        }),
      ids.userA1,
    );

    expect(error).toBeNull();
  });

  test("an author may not move a private skill into team scope", async () => {
    const skillId = await insertSkill({
      organizationId: ids.orgA,
      scope: "private",
      slug: `promote-${Bun.randomUUIDv7()}`,
      userId: ids.userA1,
    });

    const error = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      async (tx) =>
        await tryCatch(async () => {
          await tx
            .update(agentSkills)
            .set({ scope: "team" })
            .where(eq(agentSkills.id, skillId));
        }),
      ids.userA1,
    );

    expect(isPgError(error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
  });
});

type SkillRowOptions = {
  organizationId: SafeId<"organization">;
  scope: "private" | "team";
  slug: string;
  userId: SafeId<"user">;
};

const skillRow = ({
  organizationId,
  scope,
  slug,
  userId,
}: SkillRowOptions) => ({
  id: testId<"agentSkill">(),
  organizationId,
  userId,
  scope,
  origin: "upload" as const,
  slug,
  name: slug,
  description: "RLS test skill",
  metadata: {},
  contentHash: "0".repeat(64),
  body: "Use this only for RLS tests.",
  enabled: true,
});

const insertSkill = async (options: SkillRowOptions) => {
  const row = skillRow(options);
  await testDb.insert(agentSkills).values(row);
  return row.id;
};

const insertResource = async ({
  organizationId,
  path,
  skillId,
}: {
  organizationId: SafeId<"organization">;
  path: string;
  skillId: SafeId<"agentSkill">;
}) => {
  const id = testId<"agentSkillResource">();
  await testDb.insert(agentSkillResources).values({
    id,
    organizationId,
    skillId,
    path,
    kind: "reference",
    content: "resource",
    sizeBytes: 8,
  });
  return id;
};

const tryCatch = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};
