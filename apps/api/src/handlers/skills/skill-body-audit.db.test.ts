import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  agentSkillProposals,
  agentSkillRevisions,
  agentSkills,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
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

import reviewSkillProposal from "./proposals/review";
import updateSkillProposal from "./proposals/update";
import updateSkill from "./update";

/**
 * Skill and proposal bodies run to tens of thousands of characters and the
 * revision history already keeps every one of them. An audit row records that
 * a body changed, how large it was, and a digest to tell versions apart, never
 * the text itself.
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

const OLD_BODY = "Original instructions: cite every clause you rely on.";
const NEW_BODY = "Revised instructions: cite every clause and its page.";

const managerSafeDb = (): SafeDb =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userAdmin));

const recordingAudit = () => {
  const events: AuditEvent[] = [];
  const recordAuditEvent: AuditRecorder = async (_tx, event) => {
    events.push(...(Array.isArray(event) ? event : [event]));
    await Promise.resolve();
  };
  return { events, recordAuditEvent };
};

const sha256 = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

const expectedBodyChange = {
  old: {
    sizeBytes: new TextEncoder().encode(OLD_BODY).byteLength,
    sha256: sha256(OLD_BODY),
  },
  new: {
    sizeBytes: new TextEncoder().encode(NEW_BODY).byteLength,
    sha256: sha256(NEW_BODY),
  },
};

const expectNoBodyText = (events: AuditEvent[]) => {
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain(OLD_BODY);
  expect(serialized).not.toContain(NEW_BODY);
};

const insertTeamSkill = async () => {
  const skillId = toSafeId<"agentSkill">(Bun.randomUUIDv7());
  const slug = `audit-body-${Bun.randomUUIDv7()}`;
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
    body: OLD_BODY,
    enabled: true,
  });
  return skillId;
};

const insertProposal = async (skillId: SafeId<"agentSkill">) => {
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
    body: OLD_BODY,
    authorId: ids.userAdmin,
  });
  return proposalId;
};

describe("skill body audit rows", () => {
  test("editing a skill records the body's size and digest", async () => {
    const skillId = await insertTeamSkill();
    const { events, recordAuditEvent } = recordingAudit();

    await updateSkill.handler(
      createTestHandlerContext<Parameters<typeof updateSkill.handler>[0]>({
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userAdmin },
        safeDb: managerSafeDb(),
        recordAuditEvent,
        params: { skillId },
        body: { body: NEW_BODY },
      }),
    );

    expect(events.map((event) => event.changes?.["body"])).toEqual([
      expectedBodyChange,
    ]);
    expectNoBodyText(events);
  });

  test("accepting a proposal records the body's size and digest", async () => {
    const skillId = await insertTeamSkill();
    const proposalId = await insertProposal(skillId);
    await testDb
      .update(agentSkillProposals)
      .set({ body: NEW_BODY, status: "proposed" })
      .where(eq(agentSkillProposals.id, proposalId));
    const { events, recordAuditEvent } = recordingAudit();

    await reviewSkillProposal.handler(
      createTestHandlerContext<
        Parameters<typeof reviewSkillProposal.handler>[0]
      >({
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userAdmin },
        safeDb: managerSafeDb(),
        recordAuditEvent,
        params: { skillId, proposalId },
        body: { decision: "accepted" },
      }),
    );

    expect(
      events
        .map((event) => event.changes?.["body"])
        .filter((change) => change !== undefined),
    ).toEqual([expectedBodyChange]);
    expectNoBodyText(events);
  });

  test("editing a proposal records the body's size and digest", async () => {
    const skillId = await insertTeamSkill();
    const proposalId = await insertProposal(skillId);
    const { events, recordAuditEvent } = recordingAudit();

    await updateSkillProposal.handler(
      createTestHandlerContext<
        Parameters<typeof updateSkillProposal.handler>[0]
      >({
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userAdmin },
        safeDb: managerSafeDb(),
        recordAuditEvent,
        params: { skillId, proposalId },
        body: { body: NEW_BODY },
      }),
    );

    expect(events.map((event) => event.changes?.["body"])).toEqual([
      expectedBodyChange,
    ]);
    expectNoBodyText(events);
  });
});
