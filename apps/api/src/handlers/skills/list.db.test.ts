import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { listSkillMetadata, readSkillDisplayName } from "@stll/skills";

import { member, user } from "@/api/db/auth-schema";
import { agentSkillRevisions } from "@/api/db/schema";
import type { AgentSkillOrigin } from "@/api/db/schema";
import { DEFAULT_SKILL_BODY_BY_SLUG } from "@/api/lib/agent-skills/default-skills";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import {
  insertTestSkill,
  skillHandlerContext,
} from "@/api/tests/helpers/agent-skill-db";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import listSkills from "./list";

type ListContext = Parameters<typeof listSkills.handler>[0];

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

describe("listing skills", () => {
  test("returns every shipped built-in skill beside the installed page", async () => {
    const result = await listSkills.handler(
      skillHandlerContext<ListContext>({
        testDb,
        organizationId: ids.orgB,
        userId: ids.userB1,
        query: {},
      }),
    );
    if (!("builtIn" in result)) {
      throw new Error("expected the skills list to succeed");
    }

    expect(result.builtIn.map(({ slug }) => slug)).toEqual(
      listSkillMetadata().map(({ name }) => name),
    );
    // A built-in is shown under its title; its slug stays the identifier.
    expect(result.builtIn.map(({ name }) => name)).toEqual(
      listSkillMetadata().map(readSkillDisplayName),
    );
    for (const skill of result.builtIn) {
      expect(skill).toMatchObject({
        enabled: true,
        id: skill.slug,
        origin: "built-in",
        scope: "built-in",
      });
    }
    expect(result.builtIn.length).toBeGreaterThan(0);
  });
});

type InsertRevisionOptions = {
  skillId: SafeId<"agentSkill">;
  revisionNumber: number;
  createdBy: string | null;
  updatedAt: Date;
};

// Revisions normally come from the body trigger; inserting them directly pins
// the author and revision number each case needs.
const insertRevision = async ({
  skillId,
  revisionNumber,
  createdBy,
  updatedAt,
}: InsertRevisionOptions) => {
  await testDb.insert(agentSkillRevisions).values({
    id: toSafeId<"agentSkillRevision">(Bun.randomUUIDv7()),
    organizationId: ids.orgB,
    skillId,
    revisionNumber,
    body: `Revision ${revisionNumber}`,
    contentHash: "0".repeat(64),
    createdBy,
    createdAt: updatedAt,
    updatedAt,
  });
};

const insertListedSkill = async (origin: AgentSkillOrigin) =>
  await insertTestSkill(testDb, {
    organizationId: ids.orgB,
    userId: ids.userB1,
    origin,
  });

// A starter skill as seeded: its slug and body, with the authorless first
// revision the body trigger writes on the owner connection.
const insertStarterSkill = async (slug: string) =>
  await insertTestSkill(testDb, {
    organizationId: ids.orgB,
    userId: ids.userB1,
    origin: "default",
    slug,
    body:
      DEFAULT_SKILL_BODY_BY_SLUG.get(slug) ??
      panic(`no starter skill has slug ${slug}`),
  });

const lastEditOf = async (skillId: SafeId<"agentSkill">) => {
  const result = await listSkills.handler(
    skillHandlerContext<ListContext>({
      testDb,
      organizationId: ids.orgB,
      userId: ids.userB1,
      query: { limit: LIMITS.agentSkillsPageSizeMax },
    }),
  );
  if (!("installed" in result)) {
    return panic("expected the skills list to succeed");
  }
  const skill = result.installed.find(({ id }) => id === skillId);
  if (!skill) {
    return panic("expected the fixture skill on the first page");
  }
  return skill.lastEdit;
};

describe("a listed skill's last edit", () => {
  test("names the member who wrote the newest revision", async () => {
    const skillId = await insertListedSkill("authored");
    const at = new Date("2026-09-01T10:00:00.000Z");
    await insertRevision({
      skillId,
      revisionNumber: 2,
      createdBy: ids.userA1,
      updatedAt: at,
    });

    expect(await lastEditOf(skillId)).toEqual({
      type: "user",
      user: { id: ids.userA1, name: "User A1", image: null },
      at,
    });
  });

  test("follows the highest revision number, not the newest row", async () => {
    const skillId = await insertListedSkill("authored");
    const newest = new Date("2026-09-03T10:00:00.000Z");
    await insertRevision({
      skillId,
      revisionNumber: 3,
      createdBy: ids.userB1,
      updatedAt: newest,
    });
    await insertRevision({
      skillId,
      revisionNumber: 2,
      createdBy: ids.userA1,
      updatedAt: new Date("2026-09-02T10:00:00.000Z"),
    });

    expect(await lastEditOf(skillId)).toEqual({
      type: "user",
      user: { id: ids.userB1, name: "User B1", image: null },
      at: newest,
    });
  });

  test("is unattributed when a system write made the newest revision", async () => {
    const skillId = await insertListedSkill("authored");
    await insertRevision({
      skillId,
      revisionNumber: 2,
      createdBy: ids.userA1,
      updatedAt: new Date("2026-09-01T10:00:00.000Z"),
    });
    const at = new Date("2026-09-02T10:00:00.000Z");
    await insertRevision({
      skillId,
      revisionNumber: 3,
      createdBy: null,
      updatedAt: at,
    });

    expect(await lastEditOf(skillId)).toEqual({ type: "unattributed", at });
  });

  test("is unattributed once the editor's account is deleted", async () => {
    const editorId = mintAuthProviderId<"user">();
    await testDb.insert(user).values({
      id: editorId,
      name: "Departing Editor",
      email: `${editorId}@test.local`,
    });
    await testDb.insert(member).values({
      id: mintAuthProviderIdValue(),
      organizationId: ids.orgB,
      userId: editorId,
      role: "member",
      createdAt: new Date(),
    });
    const skillId = await insertListedSkill("authored");
    const at = new Date("2026-09-01T10:00:00.000Z");
    await insertRevision({
      skillId,
      revisionNumber: 2,
      createdBy: editorId,
      updatedAt: at,
    });
    await testDb.delete(user).where(eq(user.id, editorId));

    expect(await lastEditOf(skillId)).toEqual({ type: "unattributed", at });
  });

  test("does not name an editor outside the organization", async () => {
    const skillId = await insertListedSkill("authored");
    const at = new Date("2026-09-01T10:00:00.000Z");
    // userA2 belongs to orgA only.
    await insertRevision({
      skillId,
      revisionNumber: 2,
      createdBy: ids.userA2,
      updatedAt: at,
    });

    expect(await lastEditOf(skillId)).toEqual({ type: "unattributed", at });
  });

  test("is stella for a starter skill no member has edited", async () => {
    const skillId = await insertStarterSkill("summarize-default");

    expect(await lastEditOf(skillId)).toMatchObject({ type: "stella" });
  });

  test("names the member who edited a starter skill", async () => {
    const skillId = await insertListedSkill("default");
    const at = new Date("2026-09-01T10:00:00.000Z");
    await insertRevision({
      skillId,
      revisionNumber: 2,
      createdBy: ids.userB1,
      updatedAt: at,
    });

    expect(await lastEditOf(skillId)).toEqual({
      type: "user",
      user: { id: ids.userB1, name: "User B1", image: null },
      at,
    });
  });

  test("is unattributed for a starter skill edited by a member who has left", async () => {
    const editorId = mintAuthProviderId<"user">();
    await testDb.insert(user).values({
      id: editorId,
      name: "Former Member",
      email: `${editorId}@test.local`,
    });
    const membershipId = mintAuthProviderIdValue();
    await testDb.insert(member).values({
      id: membershipId,
      organizationId: ids.orgB,
      userId: editorId,
      role: "member",
      createdAt: new Date(),
    });
    const skillId = await insertListedSkill("default");
    const at = new Date("2026-09-01T10:00:00.000Z");
    await insertRevision({
      skillId,
      revisionNumber: 2,
      createdBy: editorId,
      updatedAt: at,
    });
    await testDb.delete(member).where(eq(member.id, membershipId));

    expect(await lastEditOf(skillId)).toEqual({ type: "unattributed", at });
  });

  test("is unattributed for a starter skill edited by an account since deleted", async () => {
    const editorId = mintAuthProviderId<"user">();
    await testDb.insert(user).values({
      id: editorId,
      name: "Deleted Editor",
      email: `${editorId}@test.local`,
    });
    await testDb.insert(member).values({
      id: mintAuthProviderIdValue(),
      organizationId: ids.orgB,
      userId: editorId,
      role: "member",
      createdAt: new Date(),
    });
    const skillId = await insertStarterSkill("risks-default");
    const at = new Date("2026-09-01T10:00:00.000Z");
    await insertRevision({
      skillId,
      revisionNumber: 2,
      createdBy: editorId,
      updatedAt: at,
    });
    // Deleting the account clears the revision's author.
    await testDb.delete(user).where(eq(user.id, editorId));

    expect(await lastEditOf(skillId)).toEqual({ type: "unattributed", at });
  });

  test("does not sign an unedited catalogue skill as stella", async () => {
    const skillId = await insertListedSkill("bundled");

    expect(await lastEditOf(skillId)).toMatchObject({ type: "unattributed" });
  });
});
