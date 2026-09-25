import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { agentSkillResources, agentSkills, auditLogs } from "@/api/db/schema";
import { createSkillTools } from "@/api/lib/agent-skills/skill-tools";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
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
    path: "knowledge/checklist.md",
    kind: "knowledge",
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

describe("skill catalog tools", () => {
  test("answer not-found for a skill deleted after the catalog was built", async () => {
    const slug = `vanishing-${Bun.randomUUIDv7()}`;
    const skillId = await insertSkill(slug);
    const tools = createSkillTools({
      organizationId: ids.orgA,
      safeDb,
      skills: [
        {
          description: "Skill tools test skill",
          name: slug,
          version: null,
        },
      ],
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
        input: { path: "knowledge/checklist.md", skillName: slug },
        tool: tools["read-skill-resource"],
      }),
    );
  });

  test("answer not-found for a skill disabled after the catalog was built", async () => {
    const slug = `disabled-later-${Bun.randomUUIDv7()}`;
    const skillId: SafeId<"agentSkill"> = await insertSkill(slug);
    const tools = createSkillTools({
      organizationId: ids.orgA,
      safeDb,
      skills: [
        {
          description: "Skill tools test skill",
          name: slug,
          version: null,
        },
      ],
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
      organizationId: ids.orgA,
      recordReadAuditEvent: createAuditRecorder({
        organizationId: ids.orgA,
        request: new Request("http://localhost/v1/chat/send"),
        server: null,
        userId: ids.userA2,
        workspaceId: null,
      }),
      safeDb,
      skills: [
        { description: "Skill tools test skill", name: slug, version: null },
      ],
      userId: ids.userA2,
    });

    const loaded = await executeTool({
      input: { skillName: slug },
      tool: tools["load-skill"],
    });
    expect(Result.isOk(loaded)).toBe(true);
    const read = await executeTool({
      input: { path: "knowledge/checklist.md", skillName: slug },
      tool: tools["read-skill-resource"],
    });
    expect(Result.isOk(read)).toBe(true);
    expectNotFound(
      await executeTool({
        input: { path: "knowledge/absent.md", skillName: slug },
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
          path: "knowledge/checklist.md",
          resourceType: "agent_skill",
          slug,
          surface: "chat",
        },
        {
          action: "access",
          outcome: "error",
          path: "knowledge/absent.md",
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
