import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq, sql } from "drizzle-orm";

import {
  agentSkillComments,
  agentSkillProposals,
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

// Postgres's check_violation SQLSTATE. Not part of the shared PG_ERROR map
// (apps/api/src/lib/pg-error.ts) because no production code path branches on
// it; these tests only need to assert that the database rejected the row.
const CHECK_VIOLATION = "23514";

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

describe("agent skill revision trigger", () => {
  test("inserting a skill records revision 1 with its body and content hash", async () => {
    const skillId = await insertSkill({
      organizationId: ids.orgA,
      scope: "team",
      slug: `insert-revision-${Bun.randomUUIDv7()}`,
      userId: ids.userA1,
      body: "Body v1",
      contentHash: "hash-v1",
    });

    const revisions = await revisionsFor(skillId);

    expect(revisions).toHaveLength(1);
    expect(revisions.at(0)?.revisionNumber).toBe(1);
    expect(revisions.at(0)?.body).toBe("Body v1");
    expect(revisions.at(0)?.contentHash).toBe("hash-v1");
  });

  test("a body update by the skill's author creates revision 2", async () => {
    const skillId = await insertSkill({
      organizationId: ids.orgA,
      scope: "team",
      slug: `update-revision-${Bun.randomUUIDv7()}`,
      userId: ids.userA1,
      body: "Body v1",
      contentHash: "hash-v1",
    });

    await updateBody({
      skillId,
      body: "Body v2",
      contentHash: "hash-v2",
      userId: ids.userA1,
    });

    const revisions = await revisionsFor(skillId);
    expect(revisions).toHaveLength(2);
    expect(revisions.at(1)?.revisionNumber).toBe(2);
    expect(revisions.at(1)?.body).toBe("Body v2");
  });

  test("a second same-author update right after the first coalesces into the latest revision", async () => {
    const skillId = await insertSkill({
      organizationId: ids.orgA,
      scope: "team",
      slug: `coalesce-${Bun.randomUUIDv7()}`,
      userId: ids.userA1,
      body: "Body v1",
      contentHash: "hash-v1",
    });
    await updateBody({
      skillId,
      body: "Body v2",
      contentHash: "hash-v2",
      userId: ids.userA1,
    });

    await updateBody({
      skillId,
      body: "Body v2b",
      contentHash: "hash-v2b",
      userId: ids.userA1,
    });

    const revisions = await revisionsFor(skillId);
    expect(revisions).toHaveLength(2);
    expect(revisions.at(1)?.revisionNumber).toBe(2);
    expect(revisions.at(1)?.body).toBe("Body v2b");
  });

  test("an update inside an isolated-mode transaction creates a new revision even for the same author", async () => {
    const skillId = await insertSkill({
      organizationId: ids.orgA,
      scope: "team",
      slug: `isolated-${Bun.randomUUIDv7()}`,
      userId: ids.userA1,
      body: "Body v1",
      contentHash: "hash-v1",
    });
    await updateBody({
      skillId,
      body: "Body v2",
      contentHash: "hash-v2",
      userId: ids.userA1,
    });

    await updateBody({
      skillId,
      body: "Body v3",
      contentHash: "hash-v3",
      userId: ids.userA1,
      isolated: true,
    });

    const revisions = await revisionsFor(skillId);
    expect(revisions).toHaveLength(3);
    expect(revisions.at(2)?.revisionNumber).toBe(3);
    expect(revisions.at(2)?.body).toBe("Body v3");
  });

  test("a same-author update after a proposal references the latest revision creates a new revision instead of coalescing", async () => {
    const skillId = await insertSkill({
      organizationId: ids.orgA,
      scope: "team",
      slug: `referenced-${Bun.randomUUIDv7()}`,
      userId: ids.userA1,
      body: "Body v1",
      contentHash: "hash-v1",
    });
    const revision1 = await latestRevision(skillId);
    if (revision1 === undefined) {
      throw new Error("expected the insert trigger to seed revision 1");
    }
    await testDb.insert(agentSkillProposals).values({
      id: testId<"agentSkillProposal">(),
      organizationId: ids.orgA,
      skillId,
      baseRevisionId: revision1.id,
      body: "Proposed body",
      authorId: ids.userA1,
    });

    await updateBody({
      skillId,
      body: "Body v2",
      contentHash: "hash-v2",
      userId: ids.userA1,
    });

    const revisions = await revisionsFor(skillId);
    expect(revisions).toHaveLength(2);
    expect(revisions.at(1)?.revisionNumber).toBe(2);
    expect(revisions.at(1)?.body).toBe("Body v2");
  });

  test("updating a column other than body does not create a revision", async () => {
    const skillId = await insertSkill({
      organizationId: ids.orgA,
      scope: "team",
      slug: `no-revision-${Bun.randomUUIDv7()}`,
      userId: ids.userA1,
    });

    await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) =>
        tx
          .update(agentSkills)
          .set({ enabled: false })
          .where(eq(agentSkills.id, skillId)),
      ids.userA1,
    );

    expect(await revisionsFor(skillId)).toHaveLength(1);
  });
});

describe("agent skill history RLS", () => {
  test("team skill history is visible to any org member and hidden from another org", async () => {
    const skillId = await insertSkill({
      organizationId: ids.orgA,
      scope: "team",
      slug: `team-history-${Bun.randomUUIDv7()}`,
      userId: ids.userA1,
    });
    const revision = await latestRevision(skillId);
    if (revision === undefined) {
      throw new Error("expected the insert trigger to seed revision 1");
    }
    await insertProposal({ skillId, baseRevisionId: revision.id });
    await insertComment({ skillId, revisionId: revision.id });

    for (const table of [
      agentSkillRevisions,
      agentSkillProposals,
      agentSkillComments,
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- PGlite's single WASM connection cannot run concurrent transactions
      const countA1 = await scopedQuery(
        [ids.wsA1],
        ids.orgA,
        (tx) => tx.$count(table, eq(table.skillId, skillId)),
        ids.userA1,
      );
      // oxlint-disable-next-line no-await-in-loop -- PGlite's single WASM connection cannot run concurrent transactions
      const countA2 = await scopedQuery(
        [ids.wsA1],
        ids.orgA,
        (tx) => tx.$count(table, eq(table.skillId, skillId)),
        ids.userA2,
      );
      // oxlint-disable-next-line no-await-in-loop -- PGlite's single WASM connection cannot run concurrent transactions
      const countB1 = await scopedQuery(
        [ids.wsB1],
        ids.orgB,
        (tx) => tx.$count(table, eq(table.skillId, skillId)),
        ids.userB1,
      );

      expect(countA1).toBe(1);
      expect(countA2).toBe(1);
      expect(countB1).toBe(0);
    }
  });

  test("private skill history is visible only to the owner", async () => {
    const skillId = await insertSkill({
      organizationId: ids.orgA,
      scope: "private",
      slug: `private-history-${Bun.randomUUIDv7()}`,
      userId: ids.userA1,
    });
    const revision = await latestRevision(skillId);
    if (revision === undefined) {
      throw new Error("expected the insert trigger to seed revision 1");
    }
    await insertProposal({ skillId, baseRevisionId: revision.id });
    await insertComment({ skillId, revisionId: revision.id });

    for (const table of [
      agentSkillRevisions,
      agentSkillProposals,
      agentSkillComments,
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- PGlite's single WASM connection cannot run concurrent transactions
      const ownerCount = await scopedQuery(
        [ids.wsA1],
        ids.orgA,
        (tx) => tx.$count(table, eq(table.skillId, skillId)),
        ids.userA1,
      );
      // oxlint-disable-next-line no-await-in-loop -- PGlite's single WASM connection cannot run concurrent transactions
      const otherUserCount = await scopedQuery(
        [ids.wsA1],
        ids.orgA,
        (tx) => tx.$count(table, eq(table.skillId, skillId)),
        ids.userA2,
      );

      expect(ownerCount).toBe(1);
      expect(otherUserCount).toBe(0);
    }
  });

  test("proposal inserts require the referenced skill to belong to the same organization", async () => {
    const foreignSkillId = await insertSkill({
      organizationId: ids.orgB,
      scope: "team",
      slug: `foreign-history-${Bun.randomUUIDv7()}`,
      userId: ids.userB1,
    });
    const foreignRevision = await latestRevision(foreignSkillId);
    if (foreignRevision === undefined) {
      throw new Error("expected the insert trigger to seed revision 1");
    }

    const error = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      async (tx) =>
        await tryCatch(async () => {
          await tx.insert(agentSkillProposals).values({
            id: testId<"agentSkillProposal">(),
            organizationId: ids.orgA,
            skillId: foreignSkillId,
            baseRevisionId: foreignRevision.id,
            body: "cross-org proposal",
            authorId: ids.userA1,
          });
        }),
      ids.userA1,
    );

    expect(isPgError(error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
  });
});

describe("agent skill history CHECK constraints", () => {
  test("a proposal marked accepted requires decided_at", async () => {
    const skillId = await insertSkill({
      organizationId: ids.orgA,
      scope: "team",
      slug: `accepted-check-${Bun.randomUUIDv7()}`,
      userId: ids.userA1,
    });
    const revision = await latestRevision(skillId);
    if (revision === undefined) {
      throw new Error("expected the insert trigger to seed revision 1");
    }

    const error = await tryCatch(async () => {
      await testDb.insert(agentSkillProposals).values({
        id: testId<"agentSkillProposal">(),
        organizationId: ids.orgA,
        skillId,
        baseRevisionId: revision.id,
        body: "Missing decided_at",
        status: "accepted",
        decidedAt: null,
        authorId: ids.userA1,
      });
    });

    expect(isPgError(error, CHECK_VIOLATION)).toBe(true);
  });

  test("a comment range cannot end before it starts", async () => {
    const skillId = await insertSkill({
      organizationId: ids.orgA,
      scope: "team",
      slug: `range-check-${Bun.randomUUIDv7()}`,
      userId: ids.userA1,
    });
    const revision = await latestRevision(skillId);
    if (revision === undefined) {
      throw new Error("expected the insert trigger to seed revision 1");
    }

    const error = await tryCatch(async () => {
      await testDb.insert(agentSkillComments).values({
        id: testId<"agentSkillComment">(),
        organizationId: ids.orgA,
        skillId,
        revisionId: revision.id,
        rangeStart: 10,
        rangeEnd: 5,
        anchorText: "backwards range",
        body: "This range is invalid",
        authorId: ids.userA1,
      });
    });

    expect(isPgError(error, CHECK_VIOLATION)).toBe(true);
  });
});

const insertSkill = async ({
  organizationId,
  scope,
  slug,
  userId,
  body = "Use this only for revision-history tests.",
  contentHash = "0".repeat(64),
}: {
  organizationId: SafeId<"organization">;
  scope: "private" | "team";
  slug: string;
  userId: SafeId<"user">;
  body?: string;
  contentHash?: string;
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
    description: "Revision-history test skill",
    metadata: {},
    contentHash,
    body,
    enabled: true,
  });
  return id;
};

const insertProposal = async ({
  skillId,
  baseRevisionId,
}: {
  skillId: SafeId<"agentSkill">;
  baseRevisionId: SafeId<"agentSkillRevision">;
}) => {
  const id = testId<"agentSkillProposal">();
  await testDb.insert(agentSkillProposals).values({
    id,
    organizationId: ids.orgA,
    skillId,
    baseRevisionId,
    body: "Proposed body",
    authorId: ids.userA1,
  });
  return id;
};

const insertComment = async ({
  skillId,
  revisionId,
}: {
  skillId: SafeId<"agentSkill">;
  revisionId: SafeId<"agentSkillRevision">;
}) => {
  const id = testId<"agentSkillComment">();
  await testDb.insert(agentSkillComments).values({
    id,
    organizationId: ids.orgA,
    skillId,
    revisionId,
    rangeStart: 0,
    rangeEnd: 4,
    anchorText: "body",
    body: "A comment",
    authorId: ids.userA1,
  });
  return id;
};

const revisionsFor = async (skillId: SafeId<"agentSkill">) =>
  await testDb
    .select()
    .from(agentSkillRevisions)
    .where(eq(agentSkillRevisions.skillId, skillId))
    .orderBy(agentSkillRevisions.revisionNumber);

const latestRevision = async (skillId: SafeId<"agentSkill">) => {
  const rows = await testDb
    .select()
    .from(agentSkillRevisions)
    .where(eq(agentSkillRevisions.skillId, skillId))
    .orderBy(desc(agentSkillRevisions.revisionNumber))
    .limit(1);
  return rows.at(0);
};

const updateBody = async ({
  skillId,
  body,
  contentHash,
  userId,
  isolated = false,
}: {
  skillId: SafeId<"agentSkill">;
  body: string;
  contentHash: string;
  userId: SafeId<"user">;
  isolated?: boolean;
}) =>
  await scopedQuery(
    [ids.wsA1],
    ids.orgA,
    async (tx) => {
      if (isolated) {
        await tx.execute(
          sql`SET LOCAL app.agent_skill_revision_mode = 'isolated'`,
        );
      }
      await tx
        .update(agentSkills)
        .set({ body, contentHash })
        .where(eq(agentSkills.id, skillId));
    },
    userId,
  );

const tryCatch = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};
