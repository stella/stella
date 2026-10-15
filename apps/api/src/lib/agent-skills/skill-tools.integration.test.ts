import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { agentSkillResources, agentSkills, auditLogs } from "@/api/db/schema";
import {
  NO_SKILL_BINDING_SCOPE,
  resolveSkillBindingScope,
} from "@/api/lib/agent-skills/binding";
import type { SkillBindingScope } from "@/api/lib/agent-skills/binding";
import {
  offerSkillsToModel,
  SKILL_INVOCATION,
} from "@/api/lib/agent-skills/invocation";
import { createSkillTools } from "@/api/lib/agent-skills/skill-tools";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { CHAT_TOOL_SET_PURPOSE } from "@/api/lib/chat/chat-tool-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
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

const insertSkill = async (slug: string) => {
  const skillId = testId<"agentSkill">();
  await testDb.insert(agentSkills).values({
    id: skillId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    scope: "team",
    origin: "authored",
    slug,
    name: slug,
    description: "Skill tools test skill",
    metadata: {},
    contentHash: "0".repeat(64),
    body: "Follow the test methodology.",
    enabled: true,
  });
  await testDb.insert(agentSkillResources).values({
    id: testId(),
    organizationId: ids.orgA,
    skillId,
    path: "references/checklist.md",
    content: "checklist",
    sizeBytes: 9,
  });
  return skillId;
};

type ToolExecute = (input: unknown, context: unknown) => Promise<unknown>;

const executeTool = async ({
  input,
  tool,
}: {
  input: Record<string, string>;
  tool: unknown;
}) => {
  const execute = asTestRaw<{ execute?: ToolExecute } | undefined>(
    tool,
  )?.execute;
  if (execute === undefined) {
    throw new TypeError("Expected an executable skill tool");
  }
  return await Result.tryPromise({
    try: async () => await execute(input, {}),
    catch: (error) => error,
  });
};

const expectNotFound = (result: Result<unknown, unknown>) => {
  expect(Result.isError(result)).toBe(true);
  if (!Result.isError(result)) {
    return;
  }
  expect(result.error).toBeInstanceOf(ChatToolError);
  if (result.error instanceof ChatToolError) {
    expect(result.error.kind).toBe("not-found");
  }
};

/** A turn catalog holding one `auto` skill, as chat offers it. */
const catalogOf = (slug: string) =>
  offerSkillsToModel({
    invokedSkillNames: new Set(),
    skills: [
      {
        description: "Skill tools test skill",
        invocation: SKILL_INVOCATION.auto,
        name: slug,
        version: null,
      },
    ],
  });

describe("bound skills in the skill tools", () => {
  test("serve a matter-bound skill only in a conversation of that matter", async () => {
    const slug = `matter-bound-${Bun.randomUUIDv7()}`;
    const skillId = await insertSkill(slug);
    await testDb
      .update(agentSkills)
      .set({ boundWorkspaceId: ids.wsA1 })
      .where(eq(agentSkills.id, skillId));
    const toolsIn = (bindingScope: SkillBindingScope) =>
      createSkillTools({
        bindingScope,
        organizationId: ids.orgA,
        safeDb,
        skills: catalogOf(slug),
        userId: ids.userA2,
      });
    const scopeOf = async (
      homeWorkspaceId: SafeId<"workspace"> | null,
      otherWorkspaceIds: SafeId<"workspace">[],
    ) => {
      const scope = await resolveSkillBindingScope({
        homeWorkspaceId,
        otherWorkspaceIds,
        safeDb,
      });
      if (Result.isError(scope)) {
        throw scope.error;
      }
      return scope.value;
    };

    // Even a catalog that names the skill cannot load it outside its matter.
    const otherMatter = await scopeOf(ids.wsA2, []);
    expectNotFound(
      await executeTool({
        input: { skillName: slug },
        tool: toolsIn(otherMatter)["load-skill"],
      }),
    );
    expectNotFound(
      await executeTool({
        input: { path: "references/checklist.md", skillName: slug },
        tool: toolsIn(otherMatter)["read-skill-resource"],
      }),
    );

    const loaded = await executeTool({
      input: { skillName: slug },
      tool: toolsIn(await scopeOf(ids.wsA1, [ids.wsA1]))["load-skill"],
    });
    expect(Result.isOk(loaded)).toBe(true);
  });
});

describe("skill catalog tools", () => {
  test("refuse a manual skill the turn did not invoke, even by its exact slug", async () => {
    const slug = `manual-${Bun.randomUUIDv7()}`;
    const skillId = await insertSkill(slug);
    await testDb
      .update(agentSkills)
      .set({ invocation: SKILL_INVOCATION.manual })
      .where(eq(agentSkills.id, skillId));
    const manualSkill = {
      description: "Skill tools test skill",
      invocation: SKILL_INVOCATION.manual,
      name: slug,
      version: null,
    };

    const uninvoked = createSkillTools({
      bindingScope: NO_SKILL_BINDING_SCOPE,
      organizationId: ids.orgA,
      safeDb,
      skills: offerSkillsToModel({
        invokedSkillNames: new Set(),
        skills: [manualSkill],
      }),
      userId: ids.userA2,
    });
    expect(uninvoked["load-skill"]).toBeUndefined();

    // A validation set registers the tools whatever the catalog holds; the
    // name check still refuses the manual skill when the tool runs.
    const validation = createSkillTools({
      bindingScope: NO_SKILL_BINDING_SCOPE,
      organizationId: ids.orgA,
      purpose: CHAT_TOOL_SET_PURPOSE.validation,
      safeDb,
      skills: offerSkillsToModel({
        invokedSkillNames: new Set(),
        skills: [manualSkill],
      }),
      userId: ids.userA2,
    });
    expectNotFound(
      await executeTool({
        input: { skillName: slug },
        tool: validation["load-skill"],
      }),
    );
    expectNotFound(
      await executeTool({
        input: { path: "references/checklist.md", skillName: slug },
        tool: validation["read-skill-resource"],
      }),
    );

    const invoked = createSkillTools({
      bindingScope: NO_SKILL_BINDING_SCOPE,
      organizationId: ids.orgA,
      safeDb,
      skills: offerSkillsToModel({
        invokedSkillNames: new Set([slug]),
        skills: [manualSkill],
      }),
      userId: ids.userA2,
    });
    const loaded = await executeTool({
      input: { skillName: slug },
      tool: invoked["load-skill"],
    });
    expect(Result.isOk(loaded)).toBe(true);
  });

  test("answer not-found for a skill deleted after the catalog was built", async () => {
    const slug = `vanishing-${Bun.randomUUIDv7()}`;
    const skillId = await insertSkill(slug);
    const tools = createSkillTools({
      bindingScope: NO_SKILL_BINDING_SCOPE,
      organizationId: ids.orgA,
      safeDb,
      skills: catalogOf(slug),
      userId: ids.userA2,
    });

    await testDb.delete(agentSkills).where(eq(agentSkills.id, skillId));

    expectNotFound(
      await executeTool({
        input: { skillName: slug },
        tool: tools["load-skill"],
      }),
    );
    expectNotFound(
      await executeTool({
        input: { path: "references/checklist.md", skillName: slug },
        tool: tools["read-skill-resource"],
      }),
    );
  });

  test("answer not-found for a skill disabled after the catalog was built", async () => {
    const slug = `disabled-later-${Bun.randomUUIDv7()}`;
    const skillId: SafeId<"agentSkill"> = await insertSkill(slug);
    const tools = createSkillTools({
      bindingScope: NO_SKILL_BINDING_SCOPE,
      organizationId: ids.orgA,
      safeDb,
      skills: catalogOf(slug),
      userId: ids.userA2,
    });

    await testDb
      .update(agentSkills)
      .set({ enabled: false })
      .where(eq(agentSkills.id, skillId));

    expectNotFound(
      await executeTool({
        input: { skillName: slug },
        tool: tools["load-skill"],
      }),
    );
  });

  test("audit each skill read by id, slug, and path, without the content", async () => {
    const slug = `audited-${Bun.randomUUIDv7()}`;
    const skillId = await insertSkill(slug);
    const tools = createSkillTools({
      bindingScope: NO_SKILL_BINDING_SCOPE,
      organizationId: ids.orgA,
      recordReadAuditEvent: createAuditRecorder({
        organizationId: ids.orgA,
        request: new Request("http://localhost/v1/chat/send"),
        server: null,
        userId: ids.userA2,
        workspaceId: null,
      }),
      safeDb,
      skills: catalogOf(slug),
      userId: ids.userA2,
    });

    const loaded = await executeTool({
      input: { skillName: slug },
      tool: tools["load-skill"],
    });
    expect(Result.isOk(loaded)).toBe(true);
    const read = await executeTool({
      input: { path: "references/checklist.md", skillName: slug },
      tool: tools["read-skill-resource"],
    });
    expect(Result.isOk(read)).toBe(true);
    expectNotFound(
      await executeTool({
        input: { path: "references/absent.md", skillName: slug },
        tool: tools["read-skill-resource"],
      }),
    );

    const rows = await testDb
      .select({
        action: auditLogs.action,
        metadata: auditLogs.metadata,
        resourceType: auditLogs.resourceType,
      })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, skillId));
    const reads = rows.map(({ action, metadata, resourceType }) => ({
      action,
      outcome: metadata?.["outcome"],
      path: metadata?.["path"],
      resourceType,
      slug: metadata?.["slug"],
      surface: metadata?.["surface"],
    }));
    expect(reads).toEqual(
      expect.arrayContaining([
        {
          action: "access",
          outcome: "success",
          path: null,
          resourceType: "agent_skill",
          slug,
          surface: "chat",
        },
        {
          action: "access",
          outcome: "success",
          path: "references/checklist.md",
          resourceType: "agent_skill",
          slug,
          surface: "chat",
        },
        {
          action: "access",
          outcome: "error",
          path: "references/absent.md",
          resourceType: "agent_skill",
          slug,
          surface: "chat",
        },
      ]),
    );
    expect(reads).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain("Follow the test methodology.");
  });
});
