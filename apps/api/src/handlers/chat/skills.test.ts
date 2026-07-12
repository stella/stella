import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { agentSkillResources, agentSkills } from "@/api/db/schema";
import {
  canEditActiveSkill,
  loadAvailableChatSkill,
  readAvailableChatSkillResource,
  resolveActiveChatSkillContext,
} from "@/api/handlers/chat/skills";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const userId = toSafeId<"user">("user_1");
const testId = <T extends SafeIdType>() => toSafeId<T>(Bun.randomUUIDv7());

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  safeDb = async (callback) =>
    await Result.tryPromise(
      // oxlint-disable-next-line node/callback-return -- arrow body already returns the callback result
      async () => await callback(asTestRaw<Transaction>(testDb)),
    );
});

afterAll(async () => {
  await releaseRlsFixture();
});

describe("canEditActiveSkill", () => {
  test("requires agent skill update permission for private owned skills", () => {
    expect(
      canEditActiveSkill({
        memberRole: { role: "intern" },
        origin: "authored",
        scope: "private",
        skillUserId: userId,
        userId,
      }),
    ).toBe(false);

    expect(
      canEditActiveSkill({
        memberRole: { role: "member" },
        origin: "authored",
        scope: "private",
        skillUserId: userId,
        userId,
      }),
    ).toBe(true);
  });

  test("keeps team skills limited to owners and admins", () => {
    expect(
      canEditActiveSkill({
        memberRole: { role: "member" },
        origin: "authored",
        scope: "team",
        skillUserId: "other_user",
        userId,
      }),
    ).toBe(false);

    expect(
      canEditActiveSkill({
        memberRole: { role: "admin" },
        origin: "authored",
        scope: "team",
        skillUserId: "other_user",
        userId,
      }),
    ).toBe(true);
  });
});

describe("resolveActiveChatSkillContext", () => {
  test("allows enabled team skills as active chat skills for members", async () => {
    const skillId = await insertSkill({
      enabled: true,
      scope: "team",
      slug: `enabled-team-${Bun.randomUUIDv7()}`,
      userId: ids.userA1,
    });
    await insertResource({ path: "knowledge/enabled.md", skillId });

    const result = await resolveActiveChatSkillContext({
      activeSkill: { skillId, skillName: "Enabled Team Skill" },
      memberRole: { role: "member" },
      organizationId: ids.orgA,
      safeDb,
      userId: ids.userA2,
    });

    if (Result.isError(result)) {
      throw result.error;
    }

    expect(result.value?.body).toBe("Use this only for chat tests.");
    expect(result.value?.editable).toBe(false);
    expect(result.value?.resources).toEqual([
      { kind: "knowledge", path: "knowledge/enabled.md" },
    ]);
  });

  test("blocks disabled team skill bodies for non-admin members", async () => {
    const skillId = await insertSkill({
      enabled: false,
      scope: "team",
      slug: `disabled-team-${Bun.randomUUIDv7()}`,
      userId: ids.userA1,
    });
    await insertResource({ path: "knowledge/disabled.md", skillId });

    const result = await resolveActiveChatSkillContext({
      activeSkill: { skillId, skillName: "Disabled Team Skill" },
      memberRole: { role: "member" },
      organizationId: ids.orgA,
      safeDb,
      userId: ids.userA2,
    });

    expectHandlerStatus({
      message: "Expected disabled team skill to be rejected",
      result,
      status: 403,
    });
  });

  test("allows disabled team skill bodies for admins editing the skill", async () => {
    const skillId = await insertSkill({
      enabled: false,
      scope: "team",
      slug: `disabled-team-admin-${Bun.randomUUIDv7()}`,
      userId: ids.userA1,
    });

    const result = await resolveActiveChatSkillContext({
      activeSkill: { skillId, skillName: "Disabled Team Skill" },
      memberRole: { role: "admin" },
      organizationId: ids.orgA,
      safeDb,
      userId: ids.userA2,
    });

    if (Result.isError(result)) {
      throw result.error;
    }

    expect(result.value?.body).toBe("Use this only for chat tests.");
    expect(result.value?.editable).toBe(true);
  });

  test("blocks disabled non-editable team skill bodies for admins", async () => {
    const skillId = await insertSkill({
      enabled: false,
      origin: "bundled",
      scope: "team",
      slug: `disabled-team-bundled-${Bun.randomUUIDv7()}`,
      userId: ids.userA1,
    });

    const result = await resolveActiveChatSkillContext({
      activeSkill: { skillId, skillName: "Disabled Bundled Skill" },
      memberRole: { role: "admin" },
      organizationId: ids.orgA,
      safeDb,
      userId: ids.userA2,
    });

    expectHandlerStatus({
      message: "Expected disabled bundled team skill to be rejected",
      result,
      status: 403,
    });
  });

  test("keeps private active skill bodies owner-scoped", async () => {
    const skillId = await insertSkill({
      enabled: false,
      scope: "private",
      slug: `private-${Bun.randomUUIDv7()}`,
      userId: ids.userA1,
    });

    const ownerResult = await resolveActiveChatSkillContext({
      activeSkill: { skillId, skillName: "Private Skill" },
      memberRole: { role: "member" },
      organizationId: ids.orgA,
      safeDb,
      userId: ids.userA1,
    });
    const otherUserResult = await resolveActiveChatSkillContext({
      activeSkill: { skillId, skillName: "Private Skill" },
      memberRole: { role: "admin" },
      organizationId: ids.orgA,
      safeDb,
      userId: ids.userA2,
    });

    expect(Result.isError(ownerResult)).toBe(false);
    expectHandlerStatus({
      message: "Expected private skill to be hidden from other users",
      result: otherUserResult,
      status: 404,
    });
  });
});

describe("available active chat skills", () => {
  test("prioritizes the active skill row over an enabled private slug collision", async () => {
    const slug = `shared-${Bun.randomUUIDv7()}`;
    const activeTeamSkillId = await insertSkill({
      body: "Team skill body",
      enabled: true,
      scope: "team",
      slug,
      userId: ids.userA1,
    });
    const privateSkillId = await insertSkill({
      body: "Private skill body",
      enabled: true,
      scope: "private",
      slug,
      userId: ids.userA2,
    });
    await insertResource({
      content: "team resource",
      path: "knowledge/shared.md",
      skillId: activeTeamSkillId,
    });
    await insertResource({
      content: "private resource",
      path: "knowledge/shared.md",
      skillId: privateSkillId,
    });

    const activeLoadResult = await loadAvailableChatSkill({
      activeSkillId: activeTeamSkillId,
      organizationId: ids.orgA,
      safeDb,
      skillName: slug,
      userId: ids.userA2,
    });
    const fallbackLoadResult = await loadAvailableChatSkill({
      organizationId: ids.orgA,
      safeDb,
      skillName: slug,
      userId: ids.userA2,
    });
    const activeReadResult = await readAvailableChatSkillResource({
      activeSkillId: activeTeamSkillId,
      organizationId: ids.orgA,
      path: "knowledge/shared.md",
      safeDb,
      skillName: slug,
      userId: ids.userA2,
    });

    if (Result.isError(activeLoadResult)) {
      throw activeLoadResult.error;
    }
    if (Result.isError(fallbackLoadResult)) {
      throw fallbackLoadResult.error;
    }
    if (Result.isError(activeReadResult)) {
      throw activeReadResult.error;
    }

    expect(activeLoadResult.value.body).toBe("Team skill body");
    expect(fallbackLoadResult.value.body).toBe("Private skill body");
    expect(activeReadResult.value).toEqual({
      content: "team resource",
      origin: "authored",
      skillId: activeTeamSkillId,
    });
  });
});

type ActiveSkillContextResult = Awaited<
  ReturnType<typeof resolveActiveChatSkillContext>
>;

const expectHandlerStatus = ({
  message,
  result,
  status,
}: {
  message: string;
  result: ActiveSkillContextResult;
  status: 403 | 404;
}) => {
  expect(Result.isError(result)).toBe(true);
  if (!Result.isError(result)) {
    throw new TypeError(message);
  }
  expect(result.error).toBeInstanceOf(HandlerError);
  if (!(result.error instanceof HandlerError)) {
    throw new TypeError("Expected resolver to return a handler error");
  }
  expect(result.error.status).toBe(status);
};

const insertSkill = async ({
  body = "Use this only for chat tests.",
  enabled,
  origin = "authored",
  scope,
  slug,
  userId: skillUserId,
}: {
  body?: string;
  enabled: boolean;
  origin?: "authored" | "bundled" | "upload" | "url";
  scope: "private" | "team";
  slug: string;
  userId: SafeId<"user">;
}) => {
  const skillId = testId<"agentSkill">();
  await testDb.insert(agentSkills).values({
    id: skillId,
    organizationId: ids.orgA,
    userId: skillUserId,
    scope,
    origin,
    slug,
    name: slug,
    description: "Chat test skill",
    metadata: {},
    contentHash: "0".repeat(64),
    body,
    enabled,
  });
  return skillId;
};

const insertResource = async ({
  content = "resource",
  path,
  skillId,
}: {
  content?: string;
  path: string;
  skillId: SafeId<"agentSkill">;
}) => {
  const sizeBytes = new TextEncoder().encode(content).byteLength;
  await testDb.insert(agentSkillResources).values({
    id: testId(),
    organizationId: ids.orgA,
    skillId,
    path,
    kind: "knowledge",
    content,
    sizeBytes,
  });
};
