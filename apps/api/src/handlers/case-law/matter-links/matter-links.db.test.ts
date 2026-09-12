import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";

import { caseLawDecisions, caseLawMatterLinks } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import createMatterLink from "@/api/handlers/case-law/matter-links/create";
import listMatterLinks from "@/api/handlers/case-law/matter-links/list";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
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
    const cap = LIMITS.caseLawMatterLinksPerWorkspace;
    const fillerDecisions = Array.from({ length: cap }, () => ({
      id: createSafeId<"caseLawDecision">(),
      sourceId: ids.caseLawSourceId,
      caseNumber: `FILL-${createSafeId<"caseLawDecision">()}`,
      court: "Test Court",
      country: "CZE",
      language: "cs",
    }));
    await testDb.insert(caseLawDecisions).values(fillerDecisions);
    await testDb.insert(caseLawMatterLinks).values(
      fillerDecisions.map((decision) => ({
        id: createSafeId<"caseLawMatterLink">(),
        decisionId: decision.id,
        workspaceId: ids.wsA1,
        linkedBy: ids.userA1,
      })),
    );

    const refused = await call(createMatterLink, {
      body: { decisionId: decisionWithHeadnote },
    });
    expect(statusOf(refused)).toBe(400);

    const stored = await testDb
      .select({ id: caseLawMatterLinks.id })
      .from(caseLawMatterLinks)
      .where(eq(caseLawMatterLinks.decisionId, decisionWithHeadnote));
    expect(stored).toEqual([]);

    await testDb.delete(caseLawMatterLinks).where(sql`true`);
    await testDb
      .delete(caseLawDecisions)
      .where(sql`${caseLawDecisions.caseNumber} LIKE 'FILL-%'`);
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
          },
        },
      ],
    });
  });
});
