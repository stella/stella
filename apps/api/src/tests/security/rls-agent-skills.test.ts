import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { agentSkillResources, agentSkills } from "@/api/db/schema";
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

const WRITE_POLICY_MIGRATION = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260925100000_agent_skill_write_policies/migration.sql",
);

const readWritePolicies = async () =>
  await testDb.execute<{
    name: string;
    using: string | null;
    withCheck: string | null;
  }>(sql`
    SELECT
      polname AS name,
      pg_catalog.pg_get_expr(polqual, polrelid) AS using,
      pg_catalog.pg_get_expr(polwithcheck, polrelid) AS "withCheck"
    FROM pg_catalog.pg_policy
    WHERE polrelid IN (
        'public.agent_skills'::regclass,
        'public.agent_skill_resources'::regclass
      )
      AND polname NOT LIKE '%_select'
    ORDER BY polname
  `);

describe("agent skill write policy migration", () => {
  test("leaves the policies exactly as the schema declares them", async () => {
    const fromSchema = await readWritePolicies();
    const statements = readFileSync(WRITE_POLICY_MIGRATION, "utf-8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await testDb.execute(sql.raw(statement));
    }
    const migrated = await readWritePolicies();

    expect(fromSchema.rows).toHaveLength(6);
    expect(migrated.rows).toEqual(fromSchema.rows);
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

  for (const { scope, actor, allowed } of writeCases) {
    test(`${actor} ${allowed ? "may" : "may not"} update or delete a ${scope} skill and its resources`, async () => {
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
    });
  }

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

const skillRow = ({ organizationId, scope, slug, userId }: SkillRowOptions) => ({
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
