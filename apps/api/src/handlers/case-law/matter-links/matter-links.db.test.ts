import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { count, eq, inArray } from "drizzle-orm";

import { caseLawDecisions, caseLawMatterLinks } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import createMatterLinksBatch from "@/api/handlers/case-law/matter-links/batch/create";
import createMatterLink from "@/api/handlers/case-law/matter-links/create";
import listMatterLinks from "@/api/handlers/case-law/matter-links/list";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * Pinning a decision into a matter has to be safe to repeat: the results table
 * pins a whole selection at once and a decision already in the matter must not
 * fail the action. The cap is the other half — it is what stops a selection
 * from filling a matter without limit.
 */

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

const noopAuditRecorder: AuditRecorder = async () => undefined;

const workspaceContext = () => ({
  createAuditRecorder: () => noopAuditRecorder,
  getActiveWorkspaceIds: async () => [ids.wsA1],
  getAccessibleWorkspaces: async () => [
    { id: ids.wsA1, status: "active" as const },
  ],
  getWorkspaceAccess: async () => ({ id: ids.wsA1, status: "active" as const }),
  memberRole: { role: "owner" },
  orgAIConfig: null,
  orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
  promptCachingEnabled: false,
  recordAuditEvent: noopAuditRecorder,
  request: new Request("https://example.test/case/matter-links"),
  route: "/case/matter-links/:workspaceId",
  safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  scopedDb: createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  session: { activeOrganizationId: ids.orgA },
  user: { id: ids.userA1 },
  workspaceId: ids.wsA1,
});

type HandlerLike = { handler: (context: never) => Promise<unknown> };

const call = async (
  endpoint: HandlerLike,
  request: Record<string, unknown> = {},
): Promise<unknown> => {
  try {
    return await endpoint.handler(
      asTestRaw({ ...workspaceContext(), ...request }),
    );
  } catch (error) {
    return error;
  }
};

/** A refusal arrives as Elysia's status response: `{ code, response }`. */
const statusOf = (result: unknown): number | null =>
  typeof result === "object" &&
  result !== null &&
  "code" in result &&
  typeof result.code === "number"
    ? result.code
    : null;

const decisionWithHeadnote = createSafeId<"caseLawDecision">();

/** Corpus rows this test owns, so a decision id can be pinned without a fixture. */
const insertDecisions = async (
  decisionIds: readonly SafeId<"caseLawDecision">[],
): Promise<void> => {
  if (decisionIds.length === 0) {
    return;
  }
  await testDb.insert(caseLawDecisions).values(
    decisionIds.map((id) => ({
      id,
      sourceId: ids.caseLawSourceId,
      caseNumber: `FILL-${id}`,
      court: "Test Court",
      country: "CZE",
      language: "cs",
    })),
  );
};

const mintDecisionIds = (howMany: number): SafeId<"caseLawDecision">[] =>
  Array.from({ length: howMany }, () => createSafeId<"caseLawDecision">());

/** Links the matter up to its cap, whatever it already holds. */
const fillMatterToCap = async (): Promise<SafeId<"caseLawDecision">[]> => {
  const [held] = await testDb
    .select({ value: count() })
    .from(caseLawMatterLinks)
    .where(eq(caseLawMatterLinks.workspaceId, ids.wsA1));
  const decisionIds = mintDecisionIds(
    LIMITS.caseLawMatterLinksPerWorkspace - (held?.value ?? 0),
  );
  await insertDecisions(decisionIds);
  await testDb.insert(caseLawMatterLinks).values(
    decisionIds.map((decisionId) => ({
      id: createSafeId<"caseLawMatterLink">(),
      decisionId,
      workspaceId: ids.wsA1,
      linkedBy: ids.userA1,
    })),
  );
  return decisionIds;
};

/**
 * Remove only the rows this test made. The corpus table is shared with every
 * other file running against this database, so a blanket delete would take
 * their fixtures with it.
 */
const dropTestDecisions = async (
  decisionIds: readonly SafeId<"caseLawDecision">[],
): Promise<void> => {
  if (decisionIds.length === 0) {
    return;
  }
  await testDb
    .delete(caseLawMatterLinks)
    .where(inArray(caseLawMatterLinks.decisionId, [...decisionIds]));
  await testDb
    .delete(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, [...decisionIds]));
};

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  await testDb.insert(caseLawDecisions).values({
    id: decisionWithHeadnote,
    sourceId: ids.caseLawSourceId,
    caseNumber: "22 Cdo 1234/2026",
    slug: "22-cdo-1234-2026",
    ecli: "ECLI:CZ:NS:2026:22.CDO.1234.2026.1",
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionType: "rozsudek",
    metadata: { legalSentence: "  Nájemce může smlouvu vypovědět.  " },
  });
});

afterAll(async () => {
  await releaseTestDb();
});

beforeEach(async () => {
  await testDb
    .delete(caseLawMatterLinks)
    .where(eq(caseLawMatterLinks.workspaceId, ids.wsA1));
});

describe("pinning a decision into a matter", () => {
  test("pinning a decision twice returns the link already there", async () => {
    const first = await call(createMatterLink, {
      body: { decisionId: decisionWithHeadnote, note: "First pin" },
    });
    expect(first).toMatchObject({ note: "First pin" });

    const second = await call(createMatterLink, {
      body: { decisionId: decisionWithHeadnote, note: "Second pin" },
    });
    expect(statusOf(second)).toBeNull();

    const stored = await testDb
      .select({ id: caseLawMatterLinks.id, note: caseLawMatterLinks.note })
      .from(caseLawMatterLinks)
      .where(eq(caseLawMatterLinks.decisionId, decisionWithHeadnote));
    // The existing link, unchanged: a repeated pin neither fails nor
    // overwrites the note somebody already wrote.
    expect(stored).toHaveLength(1);
    expect(second).toMatchObject({ id: stored[0]?.id, note: "First pin" });
  });

  test("the matter is refused a link past its cap", async () => {
    const fillerDecisionIds = await fillMatterToCap();

    const refused = await call(createMatterLink, {
      body: { decisionId: decisionWithHeadnote },
    });
    expect(statusOf(refused)).toBe(400);

    const stored = await testDb
      .select({ id: caseLawMatterLinks.id })
      .from(caseLawMatterLinks)
      .where(eq(caseLawMatterLinks.decisionId, decisionWithHeadnote));
    expect(stored).toEqual([]);

    await dropTestDecisions(fillerDecisionIds);
  });

  test("a decision already pinned is returned even when the matter is full", async () => {
    const first = await call(createMatterLink, {
      body: { decisionId: decisionWithHeadnote, note: "Pinned early" },
    });
    expect(first).toMatchObject({ note: "Pinned early" });

    // Fill the remaining slots, so the matter is at its cap with this
    // decision's link among them.
    const fillerDecisionIds = await fillMatterToCap();

    const again = await call(createMatterLink, {
      body: { decisionId: decisionWithHeadnote, note: "Pinned again" },
    });
    // Re-pinning inserts nothing, so there is nothing for the cap to refuse.
    expect(statusOf(again)).toBeNull();
    expect(again).toMatchObject({ note: "Pinned early" });

    await dropTestDecisions(fillerDecisionIds);
  });

  test("the list carries the row facts the results table renders", async () => {
    await call(createMatterLink, {
      body: { decisionId: decisionWithHeadnote, note: "Relevant" },
    });

    const listed = await call(listMatterLinks);
    expect(listed).toMatchObject({
      links: [
        {
          decisionId: decisionWithHeadnote,
          note: "Relevant",
          decision: {
            caseNumber: "22 Cdo 1234/2026",
            slug: "22-cdo-1234-2026",
            ecli: "ECLI:CZ:NS:2026:22.CDO.1234.2026.1",
            court: "Nejvyšší soud",
            country: "CZE",
            language: "cs",
            decisionType: "rozsudek",
            citationCount: 0,
            // Trimmed by the same reader the search hit uses.
            headnote: {
              type: "present",
              text: "Nájemce může smlouvu vypovědět.",
            },
            // A decision with one language version offers nothing to choose
            // from; the field is there so the client can route either way.
            languageAlternates: [],
          },
        },
      ],
    });
  });
});

describe("pinning a selection into a matter", () => {
  test("one call reports every decision it was given", async () => {
    const readable = createSafeId<"caseLawDecision">();
    await insertDecisions([readable]);
    const unknown = createSafeId<"caseLawDecision">();
    await call(createMatterLink, {
      body: { decisionId: decisionWithHeadnote, note: "Pinned earlier" },
    });

    const outcome = await call(createMatterLinksBatch, {
      body: {
        items: [
          { decisionId: readable, note: "New" },
          { decisionId: decisionWithHeadnote, note: "Ignored" },
          { decisionId: unknown },
        ],
      },
    });

    expect(outcome).toMatchObject({
      linked: [{ decisionId: readable, note: "New" }],
      // Returned unchanged: the note somebody already wrote survives.
      existing: [{ decisionId: decisionWithHeadnote, note: "Pinned earlier" }],
      rejected: [{ decisionId: unknown, reason: "not_found" }],
    });

    await dropTestDecisions([readable]);
  });

  test("parallel calls near the cap cannot commit past it", async () => {
    const cap = LIMITS.caseLawMatterLinksPerWorkspace;
    const fillerDecisionIds = await fillMatterToCap();
    // Free exactly two slots, then ask two concurrent calls for two each.
    const freed = fillerDecisionIds.slice(0, 2);
    await testDb
      .delete(caseLawMatterLinks)
      .where(inArray(caseLawMatterLinks.decisionId, [...freed]));

    const wanted = mintDecisionIds(4);
    await insertDecisions(wanted);
    const [outcomeA, outcomeB] = await Promise.all([
      call(createMatterLinksBatch, {
        body: { items: wanted.slice(0, 2).map((id) => ({ decisionId: id })) },
      }),
      call(createMatterLinksBatch, {
        body: { items: wanted.slice(2).map((id) => ({ decisionId: id })) },
      }),
    ]);

    const [held] = await testDb
      .select({ value: count() })
      .from(caseLawMatterLinks)
      .where(eq(caseLawMatterLinks.workspaceId, ids.wsA1));
    // Both calls saw two free slots if the cap were counted outside a lock;
    // under the lock the second one finds none and says so.
    expect(held?.value ?? 0).toBe(cap);
    const refused = [outcomeA, outcomeB].flatMap((outcome) =>
      typeof outcome === "object" &&
      outcome !== null &&
      "rejected" in outcome &&
      Array.isArray(outcome.rejected)
        ? outcome.rejected
        : [],
    );
    expect(refused).toHaveLength(2);
    expect(refused.every((entry) => entry.reason === "limit")).toBe(true);

    await dropTestDecisions([...fillerDecisionIds, ...wanted]);
  });
});
