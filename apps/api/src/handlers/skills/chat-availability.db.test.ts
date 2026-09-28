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

import listSkillCommands from "./commands/list";
import listSkills from "./list";
import uploadSkill from "./upload";

/**
 * A skill that declares `stella-required-tools` is offered in chat only when
 * chat has those tools. Chat registers `save_playbook` only for a caller with
 * a matter to write to, so the same caller sees the playbook skill offered or
 * hidden depending on the matters they can reach.
 */

const RUN = Bun.randomUUIDv7().slice(-10);
const PLAIN_SLUG = `plain-${RUN}`;
const PLAYBOOK_SLUG = `playbook-builder-${RUN}`;
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
    [PLAYBOOK_SLUG, { [SKILL_REQUIRED_TOOLS_METADATA_KEY]: "save_playbook" }],
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

const commandSlugs = async (workspaces: AccessibleWorkspace[]) => {
  const result = await listSkillCommands.handler(
    createTestHandlerContext<Parameters<typeof listSkillCommands.handler>[0]>(
      callerContext(workspaces),
    ),
  );
  if ("code" in result) {
    throw new TypeError("expected the command list");
  }
  return result
    .map(({ command }) => command)
    .filter((command) => command === PLAIN_SLUG || command === PLAYBOOK_SLUG);
};

describe("skills offered in chat", () => {
  test("the command menu offers a playbook skill only where chat can save playbooks", async () => {
    expect(await commandSlugs(WITH_MATTER())).toEqual(
      expect.arrayContaining([PLAIN_SLUG, PLAYBOOK_SLUG]),
    );
    expect(await commandSlugs([])).toEqual([PLAIN_SLUG]);
  });

  test("the skill list keeps every skill and says why chat hides one", async () => {
    const result = await listSkills.handler(
      createTestHandlerContext<Parameters<typeof listSkills.handler>[0]>({
        ...callerContext([]),
        query: { limit: 100 },
      }),
    );
    if ("code" in result) {
      throw new TypeError("expected the skill list");
    }
    const bySlug = new Map(
      result.installed.map((row) => [row.slug, row.chatAvailability]),
    );

    expect(bySlug.get(PLAIN_SLUG)).toEqual({ status: "available" });
    // Offered where a document is open, so the shared menus keep it.
    expect(bySlug.get(DOCUMENT_SLUG)).toEqual({ status: "available" });
    expect(bySlug.get(PLAYBOOK_SLUG)).toEqual({
      status: "unavailable",
      missingTools: ["save_playbook"],
    });
  });

  test("a skill that names a tool stella does not have is refused on upload", async () => {
    const name = `unknown-tool-${RUN}`;
    const result = await uploadSkill.handler(
      createTestHandlerContext<Parameters<typeof uploadSkill.handler>[0]>({
        ...callerContext(WITH_MATTER()),
        body: {
          scope: "private",
          file: new File(
            [
              `---\nname: ${name}\ndescription: Needs a missing tool.\nmetadata:\n  ${SKILL_REQUIRED_TOOLS_METADATA_KEY}: save_playbook save_playbok\n---\n\nBuild a playbook.\n`,
            ],
            "SKILL.md",
            { type: "text/markdown" },
          ),
        },
      }),
    );

    if (!("code" in result)) {
      throw new TypeError("expected the upload to be refused");
    }
    expect(result.code).toBe(400);
    expect(JSON.stringify(result.response)).toContain("save_playbok");
  });
});
