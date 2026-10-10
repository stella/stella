import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";

import type { PermissionInput } from "@stll/permissions";

import type { SafeDb } from "@/api/db/safe-db";
import {
  agentSkillComments,
  agentSkillProposals,
  agentSkillRevisions,
  agentSkills,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  authorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import createSkillComment from "../comments/create";
import deleteSkillComment from "../comments/delete";
import createSkillProposal from "./create";
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
  return { skillId, proposalId, revisionId: revision.id };
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
        scopedDb: NO_DB,
        audit: auditRecorderDouble(),
        memberRole: sessionMemberRole("member"),
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
        scopedDb: NO_DB,
        audit: auditRecorderDouble(),
        memberRole: sessionMemberRole("member"),
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        safeDb: memberSafeDb(),
        params: { skillId, proposalId },
      }),
    );

    expect(await proposalRow(proposalId)).toEqual([]);
  });
});

describe("a member reviewing a team skill", () => {
  test("can open a proposal branched from its newest revision", async () => {
    const { skillId, revisionId } = await insertTeamSkillWithProposal();

    const result = await createSkillProposal.handler(
      createTestHandlerContext<
        Parameters<typeof createSkillProposal.handler>[0]
      >({
        scopedDb: NO_DB,
        audit: auditRecorderDouble(),
        memberRole: sessionMemberRole("member"),
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        safeDb: memberSafeDb(),
        params: { skillId },
        body: { summary: "Tighten the wording" },
      }),
    );
    if (!("id" in result)) {
      throw new TypeError("expected the proposal to be created");
    }

    const rows = await testDb
      .select({
        baseRevisionId: agentSkillProposals.baseRevisionId,
        body: agentSkillProposals.body,
      })
      .from(agentSkillProposals)
      .where(eq(agentSkillProposals.id, result.id));
    expect(rows).toEqual([{ baseRevisionId: revisionId, body: "Team body" }]);
  });

  test("can comment on a revision", async () => {
    const { skillId, revisionId } = await insertTeamSkillWithProposal();

    await createSkillComment.handler(
      createTestHandlerContext<
        Parameters<typeof createSkillComment.handler>[0]
      >({
        scopedDb: NO_DB,
        audit: auditRecorderDouble(),
        memberRole: sessionMemberRole("member"),
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        safeDb: memberSafeDb(),
        params: { skillId },
        body: { revisionId, rangeStart: 0, rangeEnd: 4, body: "Which team?" },
      }),
    );

    const rows = await testDb
      .select({ anchorText: agentSkillComments.anchorText })
      .from(agentSkillComments)
      .where(eq(agentSkillComments.revisionId, revisionId));
    expect(rows).toEqual([{ anchorText: "Team" }]);
  });
});

describe("an owner saving a team skill a member anchored to", () => {
  const ownerSafeDb = (): SafeDb =>
    asTestRaw<SafeDb>(
      createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userAdmin),
    );

  const saveAsOwner = async (
    skillId: SafeId<"agentSkill">,
    body: string,
  ): Promise<void> => {
    const saved = await ownerSafeDb()(
      async (tx) =>
        await tx
          .update(agentSkills)
          .set({ body })
          .where(eq(agentSkills.id, skillId)),
    );
    if (saved.isErr()) {
      throw saved.error;
    }
  };

  const revisionBodies = async (skillId: SafeId<"agentSkill">) =>
    await testDb
      .select({
        revisionNumber: agentSkillRevisions.revisionNumber,
        body: agentSkillRevisions.body,
      })
      .from(agentSkillRevisions)
      .where(eq(agentSkillRevisions.skillId, skillId))
      .orderBy(agentSkillRevisions.revisionNumber);

  test("records a new revision instead of rewriting the anchored one", async () => {
    const { skillId } = await insertTeamSkillWithProposal();
    await saveAsOwner(skillId, "Owner draft");
    // Within the coalescing window the owner's next save rewrites their own
    // latest revision while nothing anchors to it.
    await saveAsOwner(skillId, "Owner draft, revised");

    const proposed = await createSkillProposal.handler(
      createTestHandlerContext<
        Parameters<typeof createSkillProposal.handler>[0]
      >({
        scopedDb: NO_DB,
        audit: auditRecorderDouble(),
        memberRole: sessionMemberRole("member"),
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        safeDb: memberSafeDb(),
        params: { skillId },
        body: { summary: "Anchor to the owner's draft" },
      }),
    );
    if (!("id" in proposed)) {
      throw new TypeError("expected the proposal to be created");
    }
    await saveAsOwner(skillId, "Owner edit after the proposal");

    expect(await revisionBodies(skillId)).toEqual([
      { revisionNumber: 1, body: "Team body" },
      { revisionNumber: 2, body: "Owner draft, revised" },
      { revisionNumber: 3, body: "Owner edit after the proposal" },
    ]);
  });
});

describe("an owner's credential managing another author's proposal or comment", () => {
  const ownerSafeDb = (): SafeDb =>
    asTestRaw<SafeDb>(
      createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userAdmin),
    );
  const ownerKey = (permissions: PermissionInput): AuthorizedMemberRole =>
    authorizedMemberRole({
      role: "owner",
      credential: { type: "attenuated", permissions },
    });
  const asOwner = (memberRole: AuthorizedMemberRole) => ({
    memberRole,
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userAdmin },
    safeDb: ownerSafeDb(),
  });

  test.each<[string, PermissionInput, boolean]>([
    ["propose only", { agentSkill: ["propose"] }, false],
    ["propose and update", { agentSkill: ["propose", "update"] }, true],
  ])(
    "edits and withdraws a peer proposal only with update (%s)",
    async (_name, permissions, allowed) => {
      const edited = await insertTeamSkillWithProposal();
      await updateSkillProposal.handler(
        createTestHandlerContext<
          Parameters<typeof updateSkillProposal.handler>[0]
        >({
          scopedDb: NO_DB,
          audit: auditRecorderDouble(),
          ...asOwner(ownerKey(permissions)),
          params: { skillId: edited.skillId, proposalId: edited.proposalId },
          body: { body: "Replacement proposal", status: "proposed" },
        }),
      );
      expect(await proposalRow(edited.proposalId)).toEqual([
        allowed
          ? { body: "Replacement proposal", status: "proposed" }
          : { body: "Proposed body", status: "draft" },
      ]);

      const withdrawn = await insertTeamSkillWithProposal();
      await deleteSkillProposal.handler(
        createTestHandlerContext<
          Parameters<typeof deleteSkillProposal.handler>[0]
        >({
          scopedDb: NO_DB,
          audit: auditRecorderDouble(),
          ...asOwner(ownerKey(permissions)),
          params: {
            skillId: withdrawn.skillId,
            proposalId: withdrawn.proposalId,
          },
        }),
      );
      expect(await proposalRow(withdrawn.proposalId)).toHaveLength(
        allowed ? 0 : 1,
      );
    },
  );

  test.each<[string, PermissionInput, boolean]>([
    ["comment only", { agentSkill: ["comment"] }, false],
    ["comment and update", { agentSkill: ["comment", "update"] }, true],
  ])(
    "removes a peer comment only with update (%s)",
    async (_name, permissions, allowed) => {
      const { skillId, revisionId } = await insertTeamSkillWithProposal();
      await createSkillComment.handler(
        createTestHandlerContext<
          Parameters<typeof createSkillComment.handler>[0]
        >({
          scopedDb: NO_DB,
          audit: auditRecorderDouble(),
          memberRole: sessionMemberRole("member"),
          session: { activeOrganizationId: ids.orgA },
          user: { id: ids.userA1 },
          safeDb: memberSafeDb(),
          params: { skillId },
          body: { revisionId, rangeStart: 0, rangeEnd: 4, body: "Peer note" },
        }),
      );
      const [comment] = await testDb
        .select({ id: agentSkillComments.id })
        .from(agentSkillComments)
        .where(eq(agentSkillComments.revisionId, revisionId));
      if (!comment) {
        throw new TypeError("expected the member's comment");
      }

      await deleteSkillComment.handler(
        createTestHandlerContext<
          Parameters<typeof deleteSkillComment.handler>[0]
        >({
          scopedDb: NO_DB,
          audit: auditRecorderDouble(),
          ...asOwner(ownerKey(permissions)),
          params: { skillId, commentId: comment.id },
        }),
      );

      const remaining = await testDb
        .select({ id: agentSkillComments.id })
        .from(agentSkillComments)
        .where(eq(agentSkillComments.id, comment.id));
      expect(remaining).toHaveLength(allowed ? 0 : 1);
    },
  );
});
