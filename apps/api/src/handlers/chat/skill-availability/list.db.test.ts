import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { SKILL_REQUIRED_TOOLS_METADATA_KEY } from "@stll/skills";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { agentSkills } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import listUnavailableChatSkills from "./list";

/**
 * A skill that declares `stella-required-tools` is offered in chat only when
 * chat has those tools. Chat registers `create_matter_document` only with a
 * matter open, so the same caller sees a skill that needs it offered or not
 * depending on whether they can reach a matter at all.
 */

const RUN = Bun.randomUUIDv7().slice(-10);
const PLAIN_SLUG = `plain-${RUN}`;
const MATTER_DOCUMENT_SLUG = `matter-document-${RUN}`;
const DOCUMENT_SLUG = `redline-${RUN}`;

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
const seededSkillIds: SafeId<"agentSkill">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  safeDb = asTestRaw<SafeDb>(
    createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  );
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  );

  for (const [slug, metadata] of [
    [PLAIN_SLUG, {}],
    [
      MATTER_DOCUMENT_SLUG,
      { [SKILL_REQUIRED_TOOLS_METADATA_KEY]: "create_matter_document" },
    ],
    [
      DOCUMENT_SLUG,
      { [SKILL_REQUIRED_TOOLS_METADATA_KEY]: "read_document suggest_changes" },
    ],
  ] as const) {
    const id = toSafeId<"agentSkill">(Bun.randomUUIDv7());
    seededSkillIds.push(id);
    await testDb.insert(agentSkills).values({
      id,
      organizationId: ids.orgA,
      userId: ids.userA1,
      scope: "private",
      origin: "authored",
      slug,
      name: slug,
      description: `Skill ${slug}.`,
      metadata,
      contentHash: "0".repeat(64),
      body: `Follow ${slug}.`,
      command: slug,
      enabled: true,
    });
  }
});

afterAll(async () => {
  await testDb
    .delete(agentSkills)
    .where(inArray(agentSkills.id, seededSkillIds));
  await releaseRlsFixture();
});

const callerContext = (workspaces: AccessibleWorkspace[]) => ({
  getAccessibleWorkspaces: async () => workspaces,
  memberRole: { role: "owner" as const },
  safeDb,
  scopedDb,
  session: { activeOrganizationId: ids.orgA },
  user: { id: ids.userA1 },
});

const WITH_MATTER = (): AccessibleWorkspace[] => [
  { id: ids.wsA1, status: "active" },
];

const unavailableIn = async (workspaces: AccessibleWorkspace[]) => {
  const result = await listUnavailableChatSkills.handler(
    createTestHandlerContext<
      Parameters<typeof listUnavailableChatSkills.handler>[0]
    >(callerContext(workspaces)),
  );
  if ("code" in result) {
    throw new TypeError("expected the availability list");
  }
  const seeded = new Set<string>(seededSkillIds);
  return result.unavailable.filter(({ skillId }) => seeded.has(skillId));
};

describe("skills chat can offer", () => {
  test("a skill that writes into a matter is unavailable to a caller with none", async () => {
    const matterDocumentId = seededSkillIds.at(1);
    if (matterDocumentId === undefined) {
      throw new TypeError("expected the matter-document skill to be seeded");
    }

    expect(await unavailableIn(WITH_MATTER())).toEqual([]);
    expect(await unavailableIn([])).toEqual([
      {
        missingTools: ["create_matter_document"],
        skillId: matterDocumentId,
      },
    ]);
  });
});
