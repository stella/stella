import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { agentSkills } from "@/api/db/schema";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { maybeSkillTools } from "@/api/lib/docx/ai-skill-tools";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

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
      async () => await callback(asTestRaw<Transaction>(testDb)),
    );
});

afterAll(async () => {
  await releaseRlsFixture();
});

const insertSkill = async ({
  body,
  enabled,
  scope,
  slug,
  userId,
}: {
  body: string;
  enabled: boolean;
  scope: "private" | "team";
  slug: string;
  userId: SafeId<"user">;
}) => {
  await testDb.insert(agentSkills).values({
    id: testId<"agentSkill">(),
    organizationId: ids.orgA,
    userId,
    scope,
    origin: "authored",
    slug,
    name: slug,
    description: "Template field skill",
    metadata: {},
    contentHash: "0".repeat(64),
    body,
    enabled,
  });
};

const refPrompt = (slug: string) =>
  `Draft the scope clause [Scope](#stella-skill-ref=${slug}).`;

const loadSkillBody = async ({
  slug,
  tools,
}: {
  slug: string;
  tools: unknown;
}) => {
  const execute = asTestRaw<{
    "load-skill"?: {
      execute?: (
        input: { skillName: string },
        context: unknown,
      ) => Promise<{ instructions: string }>;
    };
  }>(tools)["load-skill"]?.execute;
  if (execute === undefined) {
    throw new TypeError("Expected an executable load-skill tool");
  }
  return (await execute({ skillName: slug }, {})).instructions;
};

describe("maybeSkillTools", () => {
  test("serves the caller's installed skills, private first on a slug collision", async () => {
    const slug = `field-skill-${Bun.randomUUIDv7()}`;
    await insertSkill({
      body: "Team methodology",
      enabled: true,
      scope: "team",
      slug,
      userId: ids.userA1,
    });
    await insertSkill({
      body: "Private methodology",
      enabled: true,
      scope: "private",
      slug,
      userId: ids.userA2,
    });

    const result = await maybeSkillTools(refPrompt(slug), {
      organizationId: ids.orgA,
      safeDb,
      userId: ids.userA2,
    });
    if (Result.isError(result)) {
      throw result.error;
    }

    expect(result.value).toBeDefined();
    expect(await loadSkillBody({ slug, tools: result.value })).toBe(
      "Private methodology",
    );
  });

  test("leaves disabled skills out of the catalog", async () => {
    const enabledSlug = `enabled-field-skill-${Bun.randomUUIDv7()}`;
    const disabledSlug = `disabled-field-skill-${Bun.randomUUIDv7()}`;
    await insertSkill({
      body: "Enabled methodology",
      enabled: true,
      scope: "team",
      slug: enabledSlug,
      userId: ids.userA1,
    });
    await insertSkill({
      body: "Disabled methodology",
      enabled: false,
      scope: "private",
      slug: disabledSlug,
      userId: ids.userA2,
    });

    const result = await maybeSkillTools(refPrompt(disabledSlug), {
      organizationId: ids.orgA,
      safeDb,
      userId: ids.userA2,
    });
    if (Result.isError(result)) {
      throw result.error;
    }

    expect(await loadSkillBody({ slug: enabledSlug, tools: result.value })).toBe(
      "Enabled methodology",
    );
    await expect(
      loadSkillBody({ slug: disabledSlug, tools: result.value }),
    ).rejects.toThrow(/No skill named/u);
  });

  test("offers no tools for a prompt without a skill reference", async () => {
    const result = await maybeSkillTools("Draft the scope clause.", {
      organizationId: ids.orgA,
      safeDb,
      userId: ids.userA2,
    });

    expect(Result.isOk(result) && result.value === undefined).toBe(true);
  });
});
