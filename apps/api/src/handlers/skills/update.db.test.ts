import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { agentSkills } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  handlerFailure,
  insertTestSkill,
  skillHandlerContext,
} from "@/api/tests/helpers/agent-skill-db";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import updateSkill from "./update";

type UpdateContext = Parameters<typeof updateSkill.handler>[0];
type UpdateBody = UpdateContext["body"];

// The slug is also the MCP tool name suffix (`skill__<slug>`).
const SKILL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

let testDb: TestDatabase;
let ids: TestIds;
const skillIds: SafeId<"agentSkill">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  if (skillIds.length > 0) {
    await testDb.delete(agentSkills).where(inArray(agentSkills.id, skillIds));
  }
  await releaseRlsFixture();
});

const seedSkill = async () => {
  const skillId = await insertTestSkill(testDb, {
    organizationId: ids.orgA,
    userId: ids.userAdmin,
    scope: "team",
  });
  skillIds.push(skillId);
  return skillId;
};

const update = async (skillId: SafeId<"agentSkill">, body: UpdateBody) =>
  await updateSkill.handler(
    skillHandlerContext<UpdateContext>({
      testDb,
      organizationId: ids.orgA,
      userId: ids.userAdmin,
      body,
      params: { skillId },
    }),
  );

const readSkill = async (skillId: SafeId<"agentSkill">) => {
  const [row] = await testDb
    .select({ name: agentSkills.name, slug: agentSkills.slug })
    .from(agentSkills)
    .where(eq(agentSkills.id, skillId));
  return row;
};

describe("renaming a skill", () => {
  test("derives a valid slug from the new name", async () => {
    const skillId = await seedSkill();

    const result = await update(skillId, { name: "Contract Review: Žluťoučký" });

    expect(handlerFailure(result)).toBeNull();
    const row = await readSkill(skillId);
    expect(row?.name).toBe("Contract Review: Žluťoučký");
    expect(row?.slug).toMatch(SKILL_SLUG_PATTERN);
    expect(row?.slug.startsWith("contract-review-")).toBe(true);
  });

  test("two skills renamed to the same name keep distinct slugs", async () => {
    const first = await seedSkill();
    const second = await seedSkill();

    const results = [
      await update(first, { name: "Shared name" }),
      await update(second, { name: "Shared name" }),
    ];

    expect(results.map(handlerFailure)).toEqual([null, null]);
    const [firstRow, secondRow] = [
      await readSkill(first),
      await readSkill(second),
    ];
    expect(firstRow?.slug).toMatch(SKILL_SLUG_PATTERN);
    expect(secondRow?.slug).toMatch(SKILL_SLUG_PATTERN);
    expect(firstRow?.slug).not.toBe(secondRow?.slug);
  });
});
