import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { agentSkillProposals, agentSkills } from "@/api/db/schema";
import type { AgentSkillProposalStatus } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  handlerFailure,
  insertTestSkill,
  latestTestSkillRevisionId,
  skillHandlerContext,
} from "@/api/tests/helpers/agent-skill-db";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import reviewSkillProposal from "./review";

type ReviewContext = Parameters<typeof reviewSkillProposal.handler>[0];

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

const seedProposal = async (status: AgentSkillProposalStatus) => {
  const skillId = await insertTestSkill(testDb, {
    organizationId: ids.orgA,
    userId: ids.userA1,
    body: "Original instructions.",
  });
  skillIds.push(skillId);
  const proposalId = toSafeId<"agentSkillProposal">(Bun.randomUUIDv7());
  await testDb.insert(agentSkillProposals).values({
    id: proposalId,
    organizationId: ids.orgA,
    skillId,
    baseRevisionId: await latestTestSkillRevisionId(testDb, skillId),
    body: "Proposed instructions.",
    status,
    authorId: ids.userA1,
  });
  return { proposalId, skillId };
};

const review = async ({
  decision,
  proposalId,
  skillId,
}: {
  decision: "accepted" | "rejected";
  proposalId: SafeId<"agentSkillProposal">;
  skillId: SafeId<"agentSkill">;
}) =>
  await reviewSkillProposal.handler(
    skillHandlerContext<ReviewContext>({
      testDb,
      organizationId: ids.orgA,
      userId: ids.userA1,
      body: { decision },
      params: { skillId, proposalId },
    }),
  );

const readState = async ({
  proposalId,
  skillId,
}: {
  proposalId: SafeId<"agentSkillProposal">;
  skillId: SafeId<"agentSkill">;
}) => {
  const [skill] = await testDb
    .select({ body: agentSkills.body })
    .from(agentSkills)
    .where(eq(agentSkills.id, skillId));
  const [proposal] = await testDb
    .select({ status: agentSkillProposals.status })
    .from(agentSkillProposals)
    .where(eq(agentSkillProposals.id, proposalId));
  return { body: skill?.body, status: proposal?.status };
};

describe("skill proposal review", () => {
  test("only a proposal up for review can be decided", async () => {
    for (const decision of ["accepted", "rejected"] as const) {
      const draft = await seedProposal("draft");

      const result = await review({ decision, ...draft });

      expect(handlerFailure(result)?.code).toBe(409);
      expect(await readState(draft)).toEqual({
        body: "Original instructions.",
        status: "draft",
      });
    }
  });

  test("accepting a proposed change writes its body to the skill", async () => {
    const proposed = await seedProposal("proposed");

    const result = await review({ decision: "accepted", ...proposed });

    expect(handlerFailure(result)).toBeNull();
    expect(await readState(proposed)).toEqual({
      body: "Proposed instructions.",
      status: "accepted",
    });
  });
});
