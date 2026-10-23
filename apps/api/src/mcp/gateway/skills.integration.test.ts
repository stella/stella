import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { agentSkillResources, agentSkills, auditLogs } from "@/api/db/schema";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { namespaceSkillToolName } from "@/api/lib/mcp-upstream/namespace";
import { dispatchGatewayToolCall } from "@/api/mcp/gateway/dispatch-call";
import {
  getSkillPrompt,
  listSkillPrompts,
  UnknownSkillPromptError,
} from "@/api/mcp/gateway/skill-prompts";
import {
  loadVisibleSkillTools,
  readSkillTool,
  resolveSkillTool,
} from "@/api/mcp/gateway/skills";
import { handleMcpToolCall } from "@/api/mcp/tools";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
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

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  await releaseRlsFixture();
});

const insertSkill = async ({
  body,
  slug,
  userId,
}: {
  body: string;
  slug: string;
  userId: SafeId<"user">;
}) => {
  const skillId = testId<"agentSkill">();
  await testDb.insert(agentSkills).values({
    id: skillId,
    organizationId: ids.orgA,
    userId,
    scope: "private",
    origin: "authored",
    slug,
    name: slug,
    description: `Instructions for ${slug}`,
    metadata: {},
    contentHash: "0".repeat(64),
    body,
    enabled: true,
  });
  return skillId;
};

/**
 * A real database behind a `safeDb` that records every row a query returned,
 * so a test can see which instruction bodies a code path actually read.
 */
const createRecordingContext = (userId: SafeId<"user">) => {
  const returnedRows: Record<string, unknown>[] = [];
  const safeDb: SafeDb = async (callback) => {
    const result = await Result.tryPromise(
      async () => await callback(asTestRaw<Transaction>(testDb)),
    );
    if (Result.isOk(result) && Array.isArray(result.value)) {
      for (const row of result.value) {
        returnedRows.push(asTestRaw<Record<string, unknown>>(row));
      }
    }
    return result;
  };
  const context = asTestRaw<AuthorizedMcpRequestContext>({
    grantedScopes: [],
    memberRole: "owner",
    organizationId: ids.orgA,
    recordAuditEvent: createAuditRecorder({
      organizationId: ids.orgA,
      request: new Request("http://localhost/mcp"),
      server: null,
      userId,
      workspaceId: null,
    }),
    safeDb,
    userId,
  });
  const bodiesRead = () =>
    returnedRows.flatMap((row) =>
      typeof row["body"] === "string" ? [row["body"]] : [],
    );
  const resourceContentsRead = () =>
    returnedRows.flatMap((row) =>
      typeof row["content"] === "string" ? [row["content"]] : [],
    );
  return { bodiesRead, context, resourceContentsRead };
};

describe("MCP skill tools against the database", () => {
  test("tools/list reads no instruction bodies, and a call reads only its own", async () => {
    const run = Bun.randomUUIDv7();
    const listedSlug = `listed-${run}`;
    const calledSlug = `called-${run}`;
    await insertSkill({
      body: `body of ${listedSlug}`,
      slug: listedSlug,
      userId: ids.userA1,
    });
    await insertSkill({
      body: `body of ${calledSlug}`,
      slug: calledSlug,
      userId: ids.userA1,
    });

    const listing = createRecordingContext(ids.userA1);
    const tools = await loadVisibleSkillTools({
      context: listing.context,
      mode: "advanced",
    });
    expect(tools.map((tool) => tool.exposedName)).toContain(
      namespaceSkillToolName(calledSlug),
    );
    expect(listing.bodiesRead()).toEqual([]);

    const calling = createRecordingContext(ids.userA1);
    const dispatched = await dispatchGatewayToolCall({
      args: {},
      context: calling.context,
      mode: "advanced",
      toolName: namespaceSkillToolName(calledSlug),
    });
    expect(dispatched?.type).toBe("internal");
    expect(calling.bodiesRead()).toEqual([`body of ${calledSlug}`]);
  });

  test("a call names the skill's id and resource paths, and reads one resource on request", async () => {
    const slug = `packaged-${Bun.randomUUIDv7()}`;
    const skillId = await insertSkill({
      body: "Follow the checklist.",
      slug,
      userId: ids.userA1,
    });
    await testDb.insert(agentSkillResources).values({
      id: testId(),
      organizationId: ids.orgA,
      skillId,
      path: "references/checklist.md",
      content: "1. Parties\n2. Term",
      sizeBytes: 19,
    });
    const { context } = createRecordingContext(ids.userA1);
    const toolName = namespaceSkillToolName(slug);

    const skillRead = await handleMcpToolCall({
      args: {},
      context,
      toolName,
      mode: "advanced",
    });
    expect(skillRead.isError).toBeUndefined();
    expect(skillRead.structuredContent).toMatchObject({
      type: "skill",
      body: "Follow the checklist.",
      id: skillId,
      name: slug,
      resources: [{ path: "references/checklist.md" }],
    });

    const resourceRead = await handleMcpToolCall({
      mode: "advanced",
      args: { resource: "references/checklist.md" },
      context,
      toolName,
    });
    expect(resourceRead.isError).toBeUndefined();
    expect(resourceRead.structuredContent).toEqual({
      type: "resource",
      content: "1. Parties\n2. Term",
      id: skillId,
      name: slug,
      path: "references/checklist.md",
    });

    const missingRead = await handleMcpToolCall({
      mode: "advanced",
      args: { resource: "references/absent.md" },
      context,
      toolName,
    });
    expect(missingRead.isError).toBe(true);
    const item = missingRead.content.at(0);
    const parsed: unknown =
      item?.type === "text" ? JSON.parse(item.text) : undefined;
    expect(parsed).toMatchObject({ error: { code: "not_found" } });
  });

  test("audits each skill read with its outcome, the same event chat records", async () => {
    const slug = `audited-${Bun.randomUUIDv7()}`;
    const skillId = await insertSkill({
      body: "Audited instructions.",
      slug,
      userId: ids.userA1,
    });
    const { context } = createRecordingContext(ids.userA1);
    const toolName = namespaceSkillToolName(slug);

    await handleMcpToolCall({ args: {}, context, toolName, mode: "advanced" });
    await handleMcpToolCall({
      mode: "advanced",
      args: { resource: "references/absent.md" },
      context,
      toolName,
    });

    const rows = await testDb
      .select({
        action: auditLogs.action,
        metadata: auditLogs.metadata,
        resourceType: auditLogs.resourceType,
      })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, skillId));
    expect(
      rows.map(({ action, metadata, resourceType }) => ({
        action,
        outcome: metadata?.["outcome"],
        path: metadata?.["path"],
        resourceType,
        surface: metadata?.["surface"],
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          action: "access",
          outcome: "success",
          path: null,
          resourceType: "agent_skill",
          surface: "mcp",
        },
        {
          action: "access",
          outcome: "error",
          path: "references/absent.md",
          resourceType: "agent_skill",
          surface: "mcp",
        },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  test("a read never serves another row behind the resolved skill's slug", async () => {
    const slug = `shadowed-${Bun.randomUUIDv7()}`;
    const privateSkillId = await insertSkill({
      body: "Private instructions.",
      slug,
      userId: ids.userA1,
    });
    const teamSkillId = testId<"agentSkill">();
    await testDb.insert(agentSkills).values({
      id: teamSkillId,
      organizationId: ids.orgA,
      userId: ids.userA2,
      scope: "team",
      origin: "authored",
      slug,
      name: slug,
      description: `Instructions for ${slug}`,
      metadata: {},
      contentHash: "0".repeat(64),
      body: "Team instructions.",
      enabled: true,
    });
    await testDb.insert(agentSkillResources).values({
      id: testId(),
      organizationId: ids.orgA,
      skillId: teamSkillId,
      path: "references/team.md",
      content: "team only",
      sizeBytes: 9,
    });
    const { context } = createRecordingContext(ids.userA1);
    const resolved = await resolveSkillTool({
      context,
      mode: "advanced",
      toolName: namespaceSkillToolName(slug),
    });
    if (resolved?.source !== "installed" || resolved.id !== privateSkillId) {
      throw new TypeError("expected the private skill to shadow the team one");
    }

    await testDb
      .update(agentSkills)
      .set({ enabled: false })
      .where(eq(agentSkills.id, privateSkillId));

    expect(
      await readSkillTool({
        context,
        resourcePath: undefined,
        skill: resolved,
      }),
    ).toBeNull();
    expect(
      await readSkillTool({
        context,
        resourcePath: "references/team.md",
        skill: resolved,
      }),
    ).toBeNull();
  });

  test("a manual skill is a prompt with its instructions and files, and never a tool", async () => {
    const slug = `manual-${Bun.randomUUIDv7()}`;
    const skillId = await insertSkill({
      body: `body of ${slug}`,
      slug,
      userId: ids.userA1,
    });
    await testDb
      .update(agentSkills)
      .set({ invocation: "manual" })
      .where(eq(agentSkills.id, skillId));
    await testDb.insert(agentSkillResources).values({
      id: testId(),
      organizationId: ids.orgA,
      skillId,
      path: "references/checklist.md",
      content: "1. Parties\n2. Term",
      sizeBytes: 19,
    });
    const recording = createRecordingContext(ids.userA1);
    const context = asTestRaw<AuthorizedMcpRequestContext>({
      ...recording.context,
      grantedScopes: ["stella:skills"],
    });
    const name = namespaceSkillToolName(slug);

    const tools = await loadVisibleSkillTools({
      context,
      mode: "advanced",
      scopes: ["stella:skills"],
    });
    expect(tools.map((tool) => tool.exposedName)).not.toContain(name);

    const prompts = await listSkillPrompts({
      context,
      mode: "advanced",
      scopes: ["stella:skills"],
    });
    expect(prompts.map((prompt) => prompt.name)).toContain(name);
    expect(
      await listSkillPrompts({ context, mode: "advanced", scopes: [] }),
    ).toEqual([]);
    expect(
      await listSkillPrompts({
        context,
        mode: "default",
        scopes: ["stella:skills"],
      }),
    ).toEqual([]);

    const prompt = (
      await getSkillPrompt({
        args: { request: "Check the lease." },
        context,
        mode: "advanced",
        name,
      })
    ).unwrap();
    const [instructions, resource] = prompt.messages;
    expect(instructions?.content).toMatchObject({ type: "text" });
    expect(
      instructions?.content.type === "text" ? instructions.content.text : "",
    ).toContain(`body of ${slug}`);
    expect(
      instructions?.content.type === "text" ? instructions.content.text : "",
    ).toContain("Check the lease.");
    expect(resource?.content).toMatchObject({
      resource: { text: "1. Parties\n2. Term" },
      type: "resource",
    });

    const called = await dispatchGatewayToolCall({
      args: {},
      context,
      mode: "advanced",
      toolName: name,
    });
    expect(called).toMatchObject({
      result: { error: { code: "unknown_tool" }, status: "error" },
      type: "internal",
    });

    const audited = await testDb
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, skillId));
    expect(audited.map(({ metadata }) => metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: null, surface: "mcp" }),
        expect.objectContaining({
          path: "references/checklist.md",
          surface: "mcp",
        }),
      ]),
    );
  });

  test.each([60_000, 60_001])(
    "a prompt audits reads and stops after exhausting its budget (%i characters)",
    async (contentLength) => {
      const slug = `manual-budget-${Bun.randomUUIDv7()}`;
      const skillId = await insertSkill({
        body: "Follow the attached instructions.",
        slug,
        userId: ids.userA1,
      });
      await testDb
        .update(agentSkills)
        .set({ invocation: "manual" })
        .where(eq(agentSkills.id, skillId));
      const budgetContent = "x".repeat(contentLength);
      await testDb.insert(agentSkillResources).values([
        {
          id: testId<"agentSkillResource">(),
          organizationId: ids.orgA,
          skillId,
          path: "references/a.md",
          content: budgetContent,
          sizeBytes: budgetContent.length,
        },
        {
          id: testId<"agentSkillResource">(),
          organizationId: ids.orgA,
          skillId,
          path: "references/b.md",
          content: "Must stay unread.",
          sizeBytes: 17,
        },
      ]);
      const recording = createRecordingContext(ids.userA1);
      const prompt = (
        await getSkillPrompt({
          args: undefined,
          context: asTestRaw<AuthorizedMcpRequestContext>({
            ...recording.context,
            grantedScopes: ["stella:skills"],
          }),
          mode: "advanced",
          name: namespaceSkillToolName(slug),
        })
      ).unwrap();
      const budgetExhausted = contentLength === 60_000;
      expect(recording.resourceContentsRead()).toEqual(
        budgetExhausted
          ? [budgetContent]
          : [budgetContent, "Must stay unread."],
      );
      const audited = await testDb
        .select({ metadata: auditLogs.metadata })
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, skillId));
      expect(audited).toHaveLength(budgetExhausted ? 2 : 3);
      expect(audited.map(({ metadata }) => metadata?.["path"])).toEqual(
        expect.arrayContaining(
          budgetExhausted
            ? [null, "references/a.md"]
            : [null, "references/a.md", "references/b.md"],
        ),
      );
      expect(prompt.messages).toHaveLength(2);
      expect(prompt.messages.at(0)?.content).toMatchObject({
        text: expect.stringContaining(
          budgetExhausted ? "references/b.md" : "references/a.md",
        ),
        type: "text",
      });
    },
  );

  test("an unknown prompt name returns a typed error", async () => {
    const { context } = createRecordingContext(ids.userA1);
    const result = await getSkillPrompt({
      args: undefined,
      context: asTestRaw<AuthorizedMcpRequestContext>({
        ...context,
        grantedScopes: ["stella:skills"],
      }),
      mode: "advanced",
      name: "skill__does_not_exist",
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(UnknownSkillPromptError);
      expect(result.error.message).toBe(
        "Unknown prompt: skill__does_not_exist",
      );
    }
  });
});
