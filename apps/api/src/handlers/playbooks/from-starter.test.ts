import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { documentTypes, playbookDefinitions } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import createPlaybookFromStarter from "@/api/handlers/playbooks/from-starter";
import type { PlaybookPositions } from "@/api/handlers/playbooks/positions";
import { assertPositionsValid } from "@/api/handlers/playbooks/positions-validation";
import { STARTER_PLAYBOOKS } from "@/api/handlers/playbooks/starters";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { isUuid } from "@/api/lib/custom-schema";
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
): { id: SafeId<"playbookDefinition"> } => {
  expect(getStatusCode(result)).toBeNull();
  if (!isRecord(result) || typeof result["id"] !== "string") {
    throw new Error("Expected a created-playbook payload ({ id })");
  }
  return { id: toSafeId<"playbookDefinition">(result["id"]) };
};

// Every id a stored playbook's positions carry: the position `sourceId` and
// every acceptable/not-acceptable tier-rule id and fallback-entry id.
const collectAllIds = (positions: PlaybookPositions): string[] => {
  const collected: string[] = [];
  for (const position of positions.items) {
    collected.push(position.sourceId);
    if (position.mode !== "graded") {
      continue;
    }
    collected.push(
      ...position.tiers.acceptable.rules.map((rule) => rule.id),
      ...position.tiers.fallback.entries.map((entry) => entry.id),
      ...position.tiers.notAcceptable.rules.map((rule) => rule.id),
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
  // The starters scope to "nda"/"dpa"/"msa" document types; the create path
  // rejects an unknown documentTypeKey, so seed exactly the keys the starters
  // reference directly against the test driver (the production
  // `ensureDefaultDocumentTypes` helper is typed against the Bun SQL
  // production driver, not the pglite test harness).
  await testDb.insert(documentTypes).values(
    STARTER_PLAYBOOKS.map((starter, index) => ({
      organizationId: ids.orgA,
      key: starter.documentTypeKey,
      label: starter.documentTypeKey,
      sortOrder: index,
    })),
  );
});

afterAll(async () => {
  await releaseTestDb();
});

describe("starter playbook content", () => {
  test("every starter's authored positions pass assertPositionsValid", async () => {
    for (const starter of STARTER_PLAYBOOKS) {
      // oxlint-disable-next-line no-await-in-loop -- sequential validation over a fixed, small (3-item) starter list
      const result = await assertPositionsValid({
        safeDb: createScopedDbMock(noDbTx).safeDb,
        organizationId: ids.orgA,
        positions: starter.positions,
      });
      expect(Result.isError(result)).toBe(false);
    }
  });

  test("each starter has 6-8 graded positions", () => {
    for (const starter of STARTER_PLAYBOOKS) {
      expect(starter.positions.items.length).toBeGreaterThanOrEqual(6);
      expect(starter.positions.items.length).toBeLessThanOrEqual(8);
      for (const position of starter.positions.items) {
        expect(position.mode).toBe("graded");
      }
    }
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

  test("two instantiations of the same starter share no ids", async () => {
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

    expect(first.id).not.toBe(second.id);

    const rows = await testDb
      .select({
        id: playbookDefinitions.id,
        positions: playbookDefinitions.positions,
      })
      .from(playbookDefinitions)
      .where(inArray(playbookDefinitions.id, [first.id, second.id]));

    const firstRow = rows.find((row) => row.id === first.id);
    const secondRow = rows.find((row) => row.id === second.id);
    if (!firstRow || !secondRow) {
      throw new Error("Expected both instantiated playbook rows to exist");
    }

    const firstIds = new Set(collectAllIds(firstRow.positions));
    const secondIds = collectAllIds(secondRow.positions);

    for (const id of secondIds) {
      expect(firstIds.has(id)).toBe(false);
    }
  });

  test("an unknown starterId is rejected", async () => {
    const context = createOrgContext(ids.orgA, ids.userA1);

    const result = await runHandler(createPlaybookFromStarter, context, {
      body: { starterId: "not-a-real-starter" },
    });

    expect(getStatusCode(result)).toBe(404);
  });
});
