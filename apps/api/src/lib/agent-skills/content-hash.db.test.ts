import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  agentSkillProposals,
  agentSkillResources,
  agentSkills,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import createSkill from "@/api/handlers/skills/create";
import createSkillFromBlueprint from "@/api/handlers/skills/from-blueprint/create";
import reviewSkillProposal from "@/api/handlers/skills/proposals/review";
import createSkillResource from "@/api/handlers/skills/resources/create";
import deleteSkillResource from "@/api/handlers/skills/resources/delete";
import renameSkillResource from "@/api/handlers/skills/resources/rename";
import updateSkillResource from "@/api/handlers/skills/resources/update";
import uploadSkillResource from "@/api/handlers/skills/resources/upload";
import updateSkill from "@/api/handlers/skills/update";
import { seedDefaultSkills } from "@/api/lib/agent-skills/default-skills";
import { createSkillTools } from "@/api/lib/agent-skills/skill-tools";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";
import { installSkill } from "@/api/lib/skills/install";
import {
  createSkillPackageFetchContext,
  fetchSkillPackageFromUrl,
} from "@/api/lib/skills/skill-package";
import {
  handlerFailure,
  insertTestSkill,
  latestTestSkillRevisionId,
  skillHandlerContext,
} from "@/api/tests/helpers/agent-skill-db";
import { asTestExecutable, asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { hashSkillPackageContent } from "./content-hash";

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  await testDb
    .delete(agentSkills)
    .where(
      and(
        eq(agentSkills.organizationId, ids.orgA),
        inArray(agentSkills.userId, [ids.userA1, ids.userA2]),
      ),
    );
  await releaseRlsFixture();
});

/** The hash of a stored skill, recomputed from scratch in this process. */
const freshContentHash = async (skillId: SafeId<"agentSkill">) => {
  const [skill] = await testDb
    .select({
      body: agentSkills.body,
      compatibility: agentSkills.compatibility,
      description: agentSkills.description,
      license: agentSkills.license,
      metadata: agentSkills.metadata,
      name: agentSkills.name,
      version: agentSkills.version,
    })
    .from(agentSkills)
    .where(eq(agentSkills.id, skillId));
  if (!skill) {
    return panic("skill under test is missing");
  }
  const resources = await testDb
    .select({
      content: agentSkillResources.content,
      path: agentSkillResources.path,
    })
    .from(agentSkillResources)
    .where(eq(agentSkillResources.skillId, skillId));
  return hashSkillPackageContent({ ...skill, resources });
};

const storedContentHash = async (skillId: SafeId<"agentSkill">) => {
  const [row] = await testDb
    .select({ contentHash: agentSkills.contentHash })
    .from(agentSkills)
    .where(eq(agentSkills.id, skillId));
  return row?.contentHash;
};

const expectFreshHash = async (skillId: SafeId<"agentSkill">) => {
  expect(await storedContentHash(skillId)).toBe(
    await freshContentHash(skillId),
  );
};

const context = <TContext>(fields: { body?: unknown; params?: unknown }) =>
  skillHandlerContext<TContext>({
    testDb,
    organizationId: ids.orgA,
    userId: ids.userA1,
    ...fields,
  });

const expectOk = (result: unknown) => {
  expect(handlerFailure(result)).toBeNull();
};

const resultId = (result: unknown): SafeId<"agentSkill"> => {
  if (
    typeof result === "object" &&
    result !== null &&
    "id" in result &&
    typeof result.id === "string"
  ) {
    return toSafeId<"agentSkill">(result.id);
  }
  return panic(`Expected an id in ${JSON.stringify(result)}`);
};

const seedSkillWithResource = async () => {
  const skillId = await insertTestSkill(testDb, {
    organizationId: ids.orgA,
    userId: ids.userA1,
  });
  expectOk(
    await createSkillResource.handler(
      context<Parameters<typeof createSkillResource.handler>[0]>({
        body: { path: "references/checklist.md", content: "Check one." },
        params: { skillId },
      }),
    ),
  );
  return skillId;
};

const skillEditTools = (skillId: SafeId<"agentSkill">) =>
  createSkillTools({
    activeSkillContext: {
      body: "Follow the fixture instructions.",
      description: "Agent skill test fixture",
      displayName: "Fixture",
      editable: true,
      id: skillId,
      origin: "authored",
      resources: [{ kind: "reference", path: "references/checklist.md" }],
      toolName: "fixture",
      version: null,
    },
    organizationId: ids.orgA,
    recordAuditEvent: async () => undefined,
    safeDb: asTestRaw<SafeDb>(createSafeDb(testDb, [], ids.orgA, ids.userA1)),
    skills: [],
    userId: ids.userA1,
  });

const runSkillEditTool = async ({
  input,
  skillId,
  toolName,
}: {
  input: Record<string, string>;
  skillId: SafeId<"agentSkill">;
  toolName: string;
}) => {
  const tools: Record<string, unknown> = { ...skillEditTools(skillId) };
  const tool = asTestExecutable<Record<string, string>, unknown>(
    tools[toolName],
  );
  if (tool?.execute === undefined) {
    return panic(`Expected an executable ${toolName} tool`);
  }
  await tool.execute(input);
};

// Every path that writes a skill's hashed content. Each case returns the skill
// it wrote so the invariant can be checked against a fresh computation.
const MUTATION_PATHS = {
  "skills.create": async () =>
    resultId(
      await createSkill.handler(
        context<Parameters<typeof createSkill.handler>[0]>({
          body: {
            scope: "private",
            name: "Created skill",
            description: "Created through the handler.",
            body: "Created instructions.",
          },
        }),
      ),
    ),
  "skills.from-blueprint.create": async () =>
    resultId(
      await createSkillFromBlueprint.handler(
        context<Parameters<typeof createSkillFromBlueprint.handler>[0]>({
          body: { blueprintId: "check-against-rules", scope: "private" },
        }),
      ),
    ),
  "membership default skills": async () => {
    await testDb.transaction(async (tx) => {
      await seedDefaultSkills({
        organizationId: ids.orgA,
        tx: asTestRaw<Transaction>(tx),
        userId: ids.userA2,
      });
    });
    const [seeded] = await testDb
      .select({ id: agentSkills.id })
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.userId, ids.userA2),
          eq(agentSkills.slug, "summarize-default"),
        ),
      );
    return seeded?.id ?? panic("seeded skill is missing");
  },
  "skills.update body": async () => {
    const skillId = await seedSkillWithResource();
    expectOk(
      await updateSkill.handler(
        context<Parameters<typeof updateSkill.handler>[0]>({
          body: { body: "Edited instructions." },
          params: { skillId },
        }),
      ),
    );
    return skillId;
  },
  "skills.update metadata": async () => {
    const skillId = await seedSkillWithResource();
    expectOk(
      await updateSkill.handler(
        context<Parameters<typeof updateSkill.handler>[0]>({
          body: {
            name: "Renamed skill",
            description: "Edited description.",
            version: "2.0.0",
          },
          params: { skillId },
        }),
      ),
    );
    return skillId;
  },
  "skills.proposals.review": async () => {
    const skillId = await seedSkillWithResource();
    const proposalId = toSafeId<"agentSkillProposal">(Bun.randomUUIDv7());
    await testDb.insert(agentSkillProposals).values({
      id: proposalId,
      organizationId: ids.orgA,
      skillId,
      baseRevisionId: await latestTestSkillRevisionId(testDb, skillId),
      body: "Proposed instructions.",
      status: "proposed",
      authorId: ids.userA1,
    });
    expectOk(
      await reviewSkillProposal.handler(
        context<Parameters<typeof reviewSkillProposal.handler>[0]>({
          body: { decision: "accepted" },
          params: { skillId, proposalId },
        }),
      ),
    );
    return skillId;
  },
  "skills.resources.create": seedSkillWithResource,
  "skills.resources.update": async () => {
    const skillId = await seedSkillWithResource();
    expectOk(
      await updateSkillResource.handler(
        context<Parameters<typeof updateSkillResource.handler>[0]>({
          body: { path: "references/checklist.md", content: "Check two." },
          params: { skillId },
        }),
      ),
    );
    return skillId;
  },
  "skills.resources.rename": async () => {
    const skillId = await seedSkillWithResource();
    expectOk(
      await renameSkillResource.handler(
        context<Parameters<typeof renameSkillResource.handler>[0]>({
          body: {
            oldPath: "references/checklist.md",
            newPath: "references/renamed.md",
          },
          params: { skillId },
        }),
      ),
    );
    return skillId;
  },
  "skills.resources.delete": async () => {
    const skillId = await seedSkillWithResource();
    expectOk(
      await deleteSkillResource.handler(
        context<Parameters<typeof deleteSkillResource.handler>[0]>({
          body: { path: "references/checklist.md" },
          params: { skillId },
        }),
      ),
    );
    return skillId;
  },
  "skills.resources.upload": async () => {
    const skillId = await seedSkillWithResource();
    expectOk(
      await uploadSkillResource.handler(
        context<Parameters<typeof uploadSkillResource.handler>[0]>({
          body: {
            path: "knowledge/uploaded.md",
            file: new File(["Uploaded knowledge."], "uploaded.md", {
              type: "text/markdown",
            }),
          },
          params: { skillId },
        }),
      ),
    );
    return skillId;
  },
  "chat update-current-skill-body": async () => {
    const skillId = await seedSkillWithResource();
    await runSkillEditTool({
      skillId,
      toolName: "update-current-skill-body",
      input: { content: "Edited from chat." },
    });
    return skillId;
  },
  "chat update-current-skill-resource": async () => {
    const skillId = await seedSkillWithResource();
    await runSkillEditTool({
      skillId,
      toolName: "update-current-skill-resource",
      input: {
        path: "references/checklist.md",
        content: "Edited resource from chat.",
      },
    });
    return skillId;
  },
  "chat create-current-skill-resource": async () => {
    const skillId = await seedSkillWithResource();
    await runSkillEditTool({
      skillId,
      toolName: "create-current-skill-resource",
      input: { path: "knowledge/from-chat.md", content: "Created from chat." },
    });
    return skillId;
  },
} as const satisfies Record<string, () => Promise<SafeId<"agentSkill">>>;

describe("skill content hash", () => {
  for (const [path, mutate] of Object.entries(MUTATION_PATHS)) {
    test(`${path} stores the hash of the content it leaves behind`, async () => {
      const skillId = await mutate();
      await expectFreshHash(skillId);
    });
  }

  test("a URL-imported skill edited locally no longer matches its upstream package", async () => {
    const name = `edited-upstream-${Bun.randomUUIDv7().slice(-12)}`;
    const source = `---\nname: ${name}\ndescription: Upstream package.\n---\n\nUpstream instructions.`;
    const serve: typeof safeOutboundFetchBytes = async () =>
      Result.ok({
        body: new TextEncoder().encode(source).buffer,
        headers: new Headers({ "content-type": "text/markdown" }),
        ok: true,
        status: 200,
      });
    const fetched = await fetchSkillPackageFromUrl(
      `https://skills.example/${name}/SKILL.md`,
      createSkillPackageFetchContext(
        { deadlineAt: Date.now() + 30_000, maxRequests: 4 },
        serve,
      ),
    );
    if (Result.isError(fetched)) {
      throw fetched.error;
    }
    const install = async () =>
      await installSkill({
        memberRole: { role: "owner" },
        origin: "url",
        parsed: fetched.value,
        recordAuditEvent: async () => undefined,
        safeDb: asTestRaw<SafeDb>(
          createSafeDb(testDb, [], ids.orgA, ids.userA1),
        ),
        scope: "private",
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
      });

    const installed = await install();
    if (Result.isError(installed)) {
      throw installed.error;
    }
    const skillId = installed.value.id;
    await expectFreshHash(skillId);
    expectOk(
      await createSkillResource.handler(
        context<Parameters<typeof createSkillResource.handler>[0]>({
          body: { path: "references/local.md", content: "Local addition." },
          params: { skillId },
        }),
      ),
    );

    const reimported = await install();

    expect(Result.isError(reimported)).toBe(true);
    if (Result.isError(reimported)) {
      expect(reimported.error.status).toBe(409);
    }
  });
});
