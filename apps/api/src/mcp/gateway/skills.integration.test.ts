import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { agentSkillResources, agentSkills } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { dispatchGatewayToolCall } from "@/api/mcp/gateway/dispatch-call";
import { loadVisibleSkillTools } from "@/api/mcp/gateway/skills";
import { handleMcpToolCall } from "@/api/mcp/tools";
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
  const context = asTestRaw<McpRequestContext>({
    enabledRegistrySlugs: undefined,
    grantedScopes: [],
    memberRole: "owner",
    organizationId: ids.orgA,
    recordAuditEvent: asTestRaw<AuditRecorder>(async () => undefined),
    safeDb,
    userId,
  });
  const bodiesRead = () =>
    returnedRows.flatMap((row) =>
      typeof row["body"] === "string" ? [row["body"]] : [],
    );
  return { bodiesRead, context };
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
    const tools = await loadVisibleSkillTools({ context: listing.context });
    expect(tools.map((tool) => tool.exposedName)).toContain(
      `skill__${calledSlug}`,
    );
    expect(listing.bodiesRead()).toEqual([]);

    const calling = createRecordingContext(ids.userA1);
    const dispatched = await dispatchGatewayToolCall({
      args: {},
      context: calling.context,
      mode: "default",
      toolName: `skill__${calledSlug}`,
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
      path: "knowledge/checklist.md",
      kind: "knowledge",
      content: "1. Parties\n2. Term",
      sizeBytes: 19,
    });
    const { context } = createRecordingContext(ids.userA1);
    const toolName = `skill__${slug}`;

    const skillRead = await handleMcpToolCall({ args: {}, context, toolName });
    expect(skillRead.isError).toBeUndefined();
    expect(skillRead.structuredContent).toMatchObject({
      type: "skill",
      body: "Follow the checklist.",
      id: skillId,
      name: slug,
      resources: [{ kind: "knowledge", path: "knowledge/checklist.md" }],
    });

    const resourceRead = await handleMcpToolCall({
      args: { resource: "knowledge/checklist.md" },
      context,
      toolName,
    });
    expect(resourceRead.isError).toBeUndefined();
    expect(resourceRead.structuredContent).toEqual({
      type: "resource",
      content: "1. Parties\n2. Term",
      id: skillId,
      kind: "knowledge",
      name: slug,
      path: "knowledge/checklist.md",
    });

    const missingRead = await handleMcpToolCall({
      args: { resource: "knowledge/absent.md" },
      context,
      toolName,
    });
    expect(missingRead.isError).toBe(true);
    const item = missingRead.content.at(0);
    const parsed: unknown =
      item?.type === "text" ? JSON.parse(item.text) : undefined;
    expect(parsed).toMatchObject({ error: { code: "not_found" } });
  });
});
