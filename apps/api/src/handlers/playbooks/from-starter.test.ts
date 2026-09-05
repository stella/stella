import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";

import { documentTypes, playbookDefinitions } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { deriveAutoAsks } from "@/api/handlers/playbooks/derive-ask";
import createPlaybookFromStarter from "@/api/handlers/playbooks/from-starter";
import { instantiateStarterPositions } from "@/api/handlers/playbooks/instantiate-starter";
import { STARTER_PLAYBOOKS } from "@/api/handlers/playbooks/starters";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { collectNodePropertyIds } from "@/api/lib/conditions/ast-utils";
import { isUuid } from "@/api/lib/custom-schema";
import type { PlaybookPositions } from "@/api/lib/workflow/playbook-positions";
import { assertPositionsValid } from "@/api/lib/workflow/playbook-positions-validation";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

// A tx that fails if any DB call is made: every starter's ideal language is
// inline (never clause-sourced), so `assertPositionsValid` must short-circuit
// before touching the database for any of them.
const noDbTx = {
  select: () => {
    throw new Error("unexpected DB access");
  },
};

setDefaultTimeout(120_000);

// `POST /playbooks/from-starter` is root-scoped and reads the acting org from
// `session.activeOrganizationId`, so it is driven against the real pglite
// harness exactly like the document-types write-handler suite. No `orgAIConfig`
// is seeded for the test org, so the ASK auto-derivation call inside the
// shared create path fails fast (no configured provider) and falls back to
// `derived` absent — the save still succeeds, which is exactly the resilience
// `deriveAutoAsks` is designed around (see derive-ask.test.ts).

let testDb: TestDatabase;
let ids: TestIds;

const noopAuditRecorder: AuditRecorder = async () => undefined;

type OrgContext = ReturnType<typeof createOrgContext>;

const createOrgContext = (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
) => {
  const safeDb = createSafeDb(testDb, [], organizationId, userId);

  return {
    createAuditRecorder: () => noopAuditRecorder,
    memberRole: { role: "owner" as const },
    orgAIConfig: null,
    promptCachingEnabled: false,
    recordAuditEvent: noopAuditRecorder,
    request: new Request("https://example.test/playbooks/from-starter"),
    route: "/playbooks/from-starter",
    safeDb,
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
  };
};

// The exported `.handler` returns the *unwrapped* success payload on ok, or an
// Elysia status response ({ code, ... }) on error — not a raw Result.
type TestEndpoint<TContext> = {
  handler: (context: TContext) => Promise<unknown>;
};

const runHandler = async <TContext>(
  endpoint: TestEndpoint<TContext>,
  context: OrgContext,
  requestShape: Record<string, unknown>,
): Promise<unknown> => {
  try {
    return await endpoint.handler(
      asTestRaw<TContext>({ ...context, ...requestShape }),
    );
  } catch (error) {
    return error;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getStatusCode = (result: unknown): number | null => {
  if (!isRecord(result)) {
    return null;
  }
  for (const field of ["status", "statusCode", "code"] as const) {
    if (typeof result[field] === "number") {
      return result[field];
    }
  }
  return null;
};

const asCreatedPlaybook = (
  result: unknown,
): {
  id: SafeId<"playbookDefinition">;
  outcome: "created" | "existing";
} => {
  expect(getStatusCode(result)).toBeNull();
  if (
    !isRecord(result) ||
    typeof result["id"] !== "string" ||
    (result["outcome"] !== "created" && result["outcome"] !== "existing")
  ) {
    throw new Error("Expected a created-playbook payload ({ id, outcome })");
  }
  return {
    id: toSafeId<"playbookDefinition">(result["id"]),
    outcome: result["outcome"],
  };
};

// Every id a stored playbook's positions carry: the position `sourceId` and
// every acceptable/not-acceptable tier-rule id and fallback-entry id.
const collectAllIds = (positions: PlaybookPositions): string[] => {
  const collected: string[] = [];
  for (const position of positions.items) {
    collected.push(position.sourceId);
    if (position.mode !== "graded" || position.standard.source !== "tiers") {
      continue;
    }
    const { tiers } = position.standard;
    collected.push(
      ...tiers.acceptable.rules.map((rule) => rule.id),
      ...tiers.fallback.entries.map((entry) => entry.id),
      ...tiers.notAcceptable.rules.map((rule) => rule.id),
    );
  }
  return collected;
};

const readPositions = async (
  playbookId: SafeId<"playbookDefinition">,
): Promise<PlaybookPositions> => {
  const row = (
    await testDb
      .select({ positions: playbookDefinitions.positions })
      .from(playbookDefinitions)
      .where(eq(playbookDefinitions.id, playbookId))
  ).at(0);
  if (!row) {
    throw new Error("Expected the instantiated playbook row to exist");
  }
  return row.positions;
};

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  // Starters scope to their matching document types; the create path
  // rejects an unknown documentTypeKey, so seed exactly the keys the starters
  // reference directly against the test driver (the production
  // `ensureDefaultDocumentTypes` helper is typed against the Bun SQL
  // production driver, not the pglite test harness).
  await testDb.insert(documentTypes).values(
    [ids.orgA, ids.orgB].flatMap((organizationId) =>
      STARTER_PLAYBOOKS.map((starter, index) => ({
        organizationId,
        key: starter.documentTypeKey,
        label: starter.documentTypeKey,
        sortOrder: index,
      })),
    ),
  );
});

afterAll(async () => {
  await releaseTestDb();
});

describe("starter playbook content", () => {
  test("every starter's authored positions pass assertPositionsValid", async () => {
    for (const starter of STARTER_PLAYBOOKS) {
      const result = await assertPositionsValid({
        safeDb: createScopedDbMock(noDbTx).safeDb,
        organizationId: ids.orgA,
        positions: starter.positions,
      });
      expect(Result.isError(result)).toBe(false);
    }
  });

  test("each starter has 6-8 enabled positions", () => {
    for (const starter of STARTER_PLAYBOOKS) {
      expect(starter.positions.items.length).toBeGreaterThanOrEqual(6);
      expect(starter.positions.items.length).toBeLessThanOrEqual(8);
      for (const position of starter.positions.items) {
        expect(position.enabled).toBe(true);
      }
    }
  });

  test("bundled starters require no AI derivation before creation", async () => {
    let generationCalls = 0;
    const generate = async () => {
      generationCalls += 1;
      return {
        question: "Generated question",
        contentType: "text" as const,
      };
    };

    for (const starter of STARTER_PLAYBOOKS) {
      await deriveAutoAsks(instantiateStarterPositions(starter.positions), {
        organizationId: ids.orgA,
        orgAIConfig: null,
        promptCachingEnabled: false,
        generate,
      });
    }

    expect(generationCalls).toBe(0);
  });

  test("the SaaS starter demonstrates grading, exact rules, guidance, and extraction", () => {
    const starter = STARTER_PLAYBOOKS.find(
      (candidate) => candidate.starterId === "saas",
    );
    if (!starter) {
      throw new Error("expected the saas starter to exist");
    }

    expect(
      starter.positions.items.some((position) => position.mode === "extract"),
    ).toBe(true);
    expect(
      starter.positions.items.some((position) => position.mode === "graded"),
    ).toBe(true);
    expect(
      starter.positions.items.some(
        (position) =>
          position.mode === "graded" && position.check?.kind === "constraint",
      ),
    ).toBe(true);
    expect(
      starter.positions.items.some(
        (position) => position.guidance !== undefined,
      ),
    ).toBe(true);
  });

  test("instantiation remaps property references inside exact rules", () => {
    const starter = STARTER_PLAYBOOKS.find(
      (candidate) => candidate.starterId === "saas",
    );
    if (!starter) {
      throw new Error("expected the saas starter to exist");
    }
    const source = starter.positions.items.find(
      (position) =>
        position.mode === "graded" && position.check?.kind === "constraint",
    );
    if (source?.mode !== "graded" || source.check?.kind !== "constraint") {
      throw new Error("expected the saas starter to include an exact rule");
    }

    const instantiated = instantiateStarterPositions(starter.positions);
    const produced = instantiated.items.find(
      (position) => position.issue === source.issue,
    );
    if (produced?.mode !== "graded" || produced.check?.kind !== "constraint") {
      throw new Error("expected the instantiated exact rule to exist");
    }

    const referencedIds = new Set<string>();
    collectNodePropertyIds(produced.check.condition, referencedIds);
    expect(referencedIds).toEqual(new Set([produced.sourceId]));
  });
});

describe("POST /playbooks/from-starter", () => {
  test("creates a playbook with fresh, all-distinct uuids and the right position count", async () => {
    const context = createOrgContext(ids.orgA, ids.userA1);
    const starter = STARTER_PLAYBOOKS.find(
      (candidate) => candidate.starterId === "nda",
    );
    if (!starter) {
      throw new Error("expected the nda starter to exist");
    }

    const created = asCreatedPlaybook(
      await runHandler(createPlaybookFromStarter, context, {
        body: { starterId: "nda" },
      }),
    );

    const positions = await readPositions(created.id);
    expect(positions.items.length).toBe(starter.positions.items.length);

    const placeholderIds = new Set(collectAllIds(starter.positions));
    const producedIds = collectAllIds(positions);

    // Every id is a real, valid uuid...
    for (const id of producedIds) {
      expect(isUuid(id)).toBe(true);
    }
    // ...none of them are the constant's fixed placeholder ids...
    for (const id of producedIds) {
      expect(placeholderIds.has(id)).toBe(false);
    }
    // ...and all distinct from each other within this one instantiation.
    expect(new Set(producedIds).size).toBe(producedIds.length);
  });

  test("repeated use of one starter reopens the same playbook", async () => {
    const context = createOrgContext(ids.orgA, ids.userA1);

    const first = asCreatedPlaybook(
      await runHandler(createPlaybookFromStarter, context, {
        body: { starterId: "dpa" },
      }),
    );
    const second = asCreatedPlaybook(
      await runHandler(createPlaybookFromStarter, context, {
        body: { starterId: "dpa" },
      }),
    );

    expect(first).toMatchObject({ outcome: "created" });
    expect(second).toEqual({ id: first.id, outcome: "existing" });

    const rows = await testDb
      .select({
        id: playbookDefinitions.id,
      })
      .from(playbookDefinitions)
      .where(
        and(
          eq(playbookDefinitions.organizationId, ids.orgA),
          eq(playbookDefinitions.starterId, "dpa"),
        ),
      );
    expect(rows).toEqual([{ id: first.id }]);
  });

  test("concurrent use of one starter converges on one playbook", async () => {
    const context = createOrgContext(ids.orgA, ids.userA1);
    const results = await Promise.all(
      Array.from({ length: 4 }, async () =>
        asCreatedPlaybook(
          await runHandler(createPlaybookFromStarter, context, {
            body: { starterId: "msa" },
          }),
        ),
      ),
    );

    expect(new Set(results.map(({ id }) => id)).size).toBe(1);
    expect(results.filter(({ outcome }) => outcome === "created")).toHaveLength(
      1,
    );
    expect(
      results.filter(({ outcome }) => outcome === "existing"),
    ).toHaveLength(3);
  });

  test("the same starter remains independent across organizations", async () => {
    const first = asCreatedPlaybook(
      await runHandler(
        createPlaybookFromStarter,
        createOrgContext(ids.orgA, ids.userA1),
        { body: { starterId: "saas" } },
      ),
    );
    const second = asCreatedPlaybook(
      await runHandler(
        createPlaybookFromStarter,
        createOrgContext(ids.orgB, ids.userB1),
        { body: { starterId: "saas" } },
      ),
    );

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("created");
    expect(first.id).not.toBe(second.id);
  });

  test("an unknown starterId is rejected", async () => {
    const context = createOrgContext(ids.orgA, ids.userA1);

    const result = await runHandler(createPlaybookFromStarter, context, {
      body: { starterId: "not-a-real-starter" },
    });

    expect(getStatusCode(result)).toBe(404);
  });
});
