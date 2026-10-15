import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { agentSkillResources, agentSkills } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import getSkill from "@/api/handlers/skills/get";
import { resolveSkillBindingScope } from "@/api/lib/agent-skills/binding";
import {
  offerSkillsToModel,
  SKILL_INVOCATION,
} from "@/api/lib/agent-skills/invocation";
import { createSkillTools } from "@/api/lib/agent-skills/skill-tools";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { namespaceSkillToolName } from "@/api/lib/mcp-upstream/namespace";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import type { McpRequestContext } from "@/api/mcp/context";
import { dispatchGatewayToolCall } from "@/api/mcp/gateway/dispatch-call";
import { loadVisibleSkillTools } from "@/api/mcp/gateway/skills";
import {
  handlerFailure,
  skillHandlerContext,
} from "@/api/tests/helpers/agent-skill-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type {
  TestDatabase,
  createScopedQuery,
} from "@/api/tests/security/test-utils";

// The fixture: wsA1 is a matter of client contactA, wsA2 one of contactA2.
// A scoped query reaches exactly the matters it pins.
const testId = <T extends SafeIdType>() => toSafeId<T>(Bun.randomUUIDv7());

let testDb: TestDatabase;
let ids: TestIds;
let scopedQuery: ReturnType<typeof createScopedQuery>;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedQuery = fixture.scopedQuery;
});

afterAll(async () => {
  await releaseRlsFixture();
});

type BoundSkillOptions = {
  boundClientId?: SafeId<"contact"> | null;
  boundWorkspaceId?: SafeId<"workspace"> | null;
  scope: "private" | "team";
  userId: SafeId<"user">;
};

const boundSkillRow = ({
  boundClientId = null,
  boundWorkspaceId = null,
  scope,
  userId,
}: BoundSkillOptions) => {
  const slug = `bound-${Bun.randomUUIDv7()}`;
  return {
    id: testId<"agentSkill">(),
    organizationId: ids.orgA,
    userId,
    scope,
    origin: "authored" as const,
    slug,
    name: slug,
    description: "Binding RLS test skill",
    metadata: {},
    contentHash: "0".repeat(64),
    body: "Use this only for binding RLS tests.",
    enabled: true,
    boundClientId,
    boundWorkspaceId,
  };
};

const insertBoundSkill = async (options: BoundSkillOptions) => {
  const row = boundSkillRow(options);
  await testDb.insert(agentSkills).values(row);
  await testDb.insert(agentSkillResources).values({
    id: testId(),
    organizationId: ids.orgA,
    skillId: row.id,
    path: "references/bound.md",
    content: "bound",
    sizeBytes: 5,
  });
  return row.id;
};

const visibleTo = async ({
  skillId,
  userId,
  workspaceIds,
}: {
  skillId: SafeId<"agentSkill">;
  userId: SafeId<"user">;
  workspaceIds: SafeId<"workspace">[];
}) =>
  await scopedQuery(
    workspaceIds,
    ids.orgA,
    async (tx) => ({
      resources: await tx.$count(
        agentSkillResources,
        eq(agentSkillResources.skillId, skillId),
      ),
      skills: await tx.$count(agentSkills, eq(agentSkills.id, skillId)),
    }),
    userId,
  );

const tryCatch = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};

const insertAs = async ({
  options,
  userId,
  workspaceIds,
}: {
  options: BoundSkillOptions;
  userId: SafeId<"user">;
  workspaceIds: SafeId<"workspace">[];
}) =>
  await scopedQuery(
    workspaceIds,
    ids.orgA,
    async (tx) =>
      await tryCatch(async () => {
        await tx.insert(agentSkills).values(boundSkillRow(options));
      }),
    userId,
  );

describe("bound agent skill RLS", () => {
  test("a matter-bound skill and its files are visible only where its matter is reached", async () => {
    const skillId = await insertBoundSkill({
      boundWorkspaceId: ids.wsA1,
      scope: "team",
      userId: ids.userA1,
    });

    expect(
      await visibleTo({
        skillId,
        userId: ids.userA2,
        workspaceIds: [ids.wsA1],
      }),
    ).toEqual({ resources: 1, skills: 1 });
    expect(
      await visibleTo({
        skillId,
        userId: ids.userA2,
        workspaceIds: [ids.wsA2],
      }),
    ).toEqual({ resources: 0, skills: 0 });
  });

  test("a client-bound skill is visible only where a matter of that client is reached", async () => {
    const skillId = await insertBoundSkill({
      boundClientId: ids.contactA,
      scope: "team",
      userId: ids.userAdmin,
    });

    expect(
      await visibleTo({
        skillId,
        userId: ids.userA2,
        workspaceIds: [ids.wsA1],
      }),
    ).toEqual({ resources: 1, skills: 1 });
    expect(
      await visibleTo({
        skillId,
        userId: ids.userA2,
        workspaceIds: [ids.wsA2],
      }),
    ).toEqual({ resources: 0, skills: 0 });
  });

  test("a member may create a team skill only for a matter they reach", async () => {
    const inOwnMatter = await insertAs({
      options: {
        boundWorkspaceId: ids.wsA2,
        scope: "team",
        userId: ids.userA2,
      },
      userId: ids.userA2,
      workspaceIds: [ids.wsA2],
    });
    const inOtherMatter = await insertAs({
      options: {
        boundWorkspaceId: ids.wsA1,
        scope: "team",
        userId: ids.userA2,
      },
      userId: ids.userA2,
      workspaceIds: [ids.wsA2],
    });

    expect(inOwnMatter).toBeNull();
    expect(isPgError(inOtherMatter, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(
      true,
    );
  });

  test("only a manager may bind a skill to a client", async () => {
    const byMember = await insertAs({
      options: {
        boundClientId: ids.contactA,
        scope: "private",
        userId: ids.userA1,
      },
      userId: ids.userA1,
      workspaceIds: [ids.wsA1],
    });
    const byOwner = await insertAs({
      options: {
        boundClientId: ids.contactA,
        scope: "private",
        userId: ids.userAdmin,
      },
      userId: ids.userAdmin,
      workspaceIds: [ids.wsA1],
    });

    expect(isPgError(byMember, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
    expect(byOwner).toBeNull();
  });

  test("another member who reaches the matter cannot edit someone else's matter skill", async () => {
    const skillId = await insertBoundSkill({
      boundWorkspaceId: ids.wsA2,
      scope: "team",
      userId: ids.userA2,
    });

    const updatedByOther = await scopedQuery(
      [ids.wsA2],
      ids.orgA,
      async (tx) =>
        await tx
          .update(agentSkills)
          .set({ description: "changed" })
          .where(eq(agentSkills.id, skillId))
          .returning({ id: agentSkills.id }),
      ids.userA1,
    );
    const updatedByAuthor = await scopedQuery(
      [ids.wsA2],
      ids.orgA,
      async (tx) =>
        await tx
          .update(agentSkills)
          .set({ description: "changed" })
          .where(eq(agentSkills.id, skillId))
          .returning({ id: agentSkills.id }),
      ids.userA2,
    );

    expect(updatedByOther).toEqual([]);
    expect(updatedByAuthor).toEqual([{ id: skillId }]);
  });

  test("a member outside the matter cannot read or use its skill through chat, MCP or the API", async () => {
    const skillId = await insertBoundSkill({
      boundWorkspaceId: ids.wsA1,
      scope: "team",
      userId: ids.userA1,
    });
    const [skill] = await testDb
      .select({ slug: agentSkills.slug })
      .from(agentSkills)
      .where(eq(agentSkills.id, skillId));
    if (skill === undefined) {
      throw new TypeError("expected the bound skill row");
    }
    // The outsider's queries run under row security, reaching wsA2 only.
    const outsiderDb = asTestRaw<SafeDb>(
      createSafeDb(testDb, [ids.wsA2], ids.orgA, ids.userA2),
    );
    // A scope that names wsA1 takes the app-side binding check out of play,
    // so only the policy stands between the outsider and the skill.
    const ownerDb: SafeDb = async (callback) =>
      await Result.tryPromise(
        async () => await callback(asTestRaw<Transaction>(testDb)),
      );
    const matterScope = await resolveSkillBindingScope({
      homeWorkspaceId: ids.wsA1,
      otherWorkspaceIds: [],
      safeDb: ownerDb,
    });
    if (Result.isError(matterScope)) {
      throw matterScope.error;
    }

    // Chat
    const loadSkill = asTestRaw<{
      execute: (input: unknown, context: unknown) => Promise<unknown>;
    }>(
      createSkillTools({
        bindingScope: matterScope.value,
        organizationId: ids.orgA,
        safeDb: outsiderDb,
        skills: offerSkillsToModel({
          invokedSkillNames: new Set(),
          skills: [
            {
              description: "Binding RLS test skill",
              invocation: SKILL_INVOCATION.auto,
              name: skill.slug,
              version: null,
            },
          ],
        }),
        userId: ids.userA2,
      })["load-skill"],
    );
    const loaded = await Result.tryPromise({
      try: async () => await loadSkill.execute({ skillName: skill.slug }, {}),
      catch: (error) => error,
    });
    expect(
      Result.isError(loaded) &&
        loaded.error instanceof ChatToolError &&
        loaded.error.kind === "not-found",
    ).toBe(true);

    // MCP
    const context = asTestRaw<McpRequestContext>({
      enabledRegistrySlugs: undefined,
      grantedScopes: [],
      memberRole: "member",
      organizationId: ids.orgA,
      recordAuditEvent: createAuditRecorder({
        organizationId: ids.orgA,
        request: new Request("http://localhost/mcp"),
        server: null,
        userId: ids.userA2,
        workspaceId: null,
      }),
      safeDb: outsiderDb,
      userId: ids.userA2,
    });
    const toolName = namespaceSkillToolName(skill.slug);
    const listed = await loadVisibleSkillTools({ context, mode: "default" });
    expect(listed.map(({ exposedName }) => exposedName)).not.toContain(
      toolName,
    );
    expect(
      await dispatchGatewayToolCall({
        args: {},
        context,
        mode: "default",
        toolName,
      }),
    ).toMatchObject({
      result: { error: { code: "unknown_tool" }, status: "error" },
    });

    // API (what the CLI calls)
    const read = await getSkill.handler({
      ...skillHandlerContext<Parameters<typeof getSkill.handler>[0]>({
        organizationId: ids.orgA,
        params: { skillId },
        role: "member",
        testDb,
        userId: ids.userA2,
      }),
      safeDb: outsiderDb,
    });
    expect(handlerFailure(read)?.code).toBe(404);
  });

  test("a skill cannot be bound to a matter and a client at once", async () => {
    const error = await tryCatch(
      async () =>
        await testDb.insert(agentSkills).values(
          boundSkillRow({
            boundClientId: ids.contactA,
            boundWorkspaceId: ids.wsA1,
            scope: "team",
            userId: ids.userAdmin,
          }),
        ),
    );

    expect(isPgError(error, PG_ERROR.CHECK_VIOLATION)).toBe(true);
  });
});
