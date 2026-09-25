import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  agentSkillProposals,
  agentSkillRevisions,
  agentSkills,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import deleteSkillProposal from "./delete";
import updateSkillProposal from "./update";

/**
 * A member cannot write a team skill, but proposes changes to it. These run
 * the proposal handlers as a plain member against the real row-level
 * security, where a lock on the skill row would need write access to it.
 */

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  await releaseRlsFixture();
});

const memberSafeDb = (): SafeDb =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1));

const insertTeamSkillWithProposal = async () => {
  const skillId = toSafeId<"agentSkill">(Bun.randomUUIDv7());
  const slug = `member-proposal-${Bun.randomUUIDv7()}`;
  await testDb.insert(agentSkills).values({
    id: skillId,
    organizationId: ids.orgA,
    userId: ids.userAdmin,
    scope: "team",
    origin: "authored",
    slug,
    name: slug,
    description: "Team skill",
    metadata: {},
    contentHash: "0".repeat(64),
    body: "Team body",
    enabled: true,
  });
  const [revision] = await testDb
    .select({ id: agentSkillRevisions.id })
    .from(agentSkillRevisions)
    .where(eq(agentSkillRevisions.skillId, skillId))
    .orderBy(desc(agentSkillRevisions.revisionNumber))
    .limit(1);
  if (!revision) {
    throw new TypeError("expected the revision trigger to record revision 1");
  }
  const proposalId = toSafeId<"agentSkillProposal">(Bun.randomUUIDv7());
  await testDb.insert(agentSkillProposals).values({
    id: proposalId,
    organizationId: ids.orgA,
    skillId,
    baseRevisionId: revision.id,
    body: "Proposed body",
    authorId: ids.userA1,
  });
  return { skillId, proposalId };
};

const proposalRow = async (proposalId: SafeId<"agentSkillProposal">) =>
  await testDb
    .select({
      body: agentSkillProposals.body,
      status: agentSkillProposals.status,
    })
    .from(agentSkillProposals)
    .where(eq(agentSkillProposals.id, proposalId));

describe("a member's own proposal on a team skill", () => {
  test("can be edited by its author", async () => {
    const { skillId, proposalId } = await insertTeamSkillWithProposal();

    await updateSkillProposal.handler(
      createTestHandlerContext<
        Parameters<typeof updateSkillProposal.handler>[0]
      >({
        memberRole: { role: "member" },
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        safeDb: memberSafeDb(),
        params: { skillId, proposalId },
        body: { body: "Revised proposal", status: "proposed" },
      }),
    );

    expect(await proposalRow(proposalId)).toEqual([
      { body: "Revised proposal", status: "proposed" },
    ]);
  });

  test("can be withdrawn by its author", async () => {
    const { skillId, proposalId } = await insertTeamSkillWithProposal();

    await deleteSkillProposal.handler(
      createTestHandlerContext<
        Parameters<typeof deleteSkillProposal.handler>[0]
      >({
        memberRole: { role: "member" },
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        safeDb: memberSafeDb(),
        params: { skillId, proposalId },
      }),
    );

    expect(await proposalRow(proposalId)).toEqual([]);
  });
});
