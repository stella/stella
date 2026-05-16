import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

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

const insertSkill = async ({
  organizationId,
  scope,
  slug,
  userId,
}: {
  organizationId: SafeId<"organization">;
  scope: "private" | "team";
  slug: string;
  userId: SafeId<"user">;
}) => {
  const id = testId<"agentSkill">();
  await testDb.insert(agentSkills).values({
    id,
    organizationId,
    userId,
    scope,
    origin: "upload",
    slug,
    name: slug,
    description: "RLS test skill",
    metadata: {},
    contentHash: "0".repeat(64),
    body: "Use this only for RLS tests.",
    enabled: true,
  });
  return id;
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
