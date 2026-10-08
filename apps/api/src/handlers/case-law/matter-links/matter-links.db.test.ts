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

import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";

import {
  caseLawDecisions,
  caseLawMatterLinks,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import createMatterLinksBatch from "@/api/handlers/case-law/matter-links/batch/create";
import createMatterLink from "@/api/handlers/case-law/matter-links/create";
import listMatterLinks from "@/api/handlers/case-law/matter-links/list";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { capabilityRoute } from "@/api/lib/capability-route";
import { LIMITS } from "@/api/lib/limits";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { McpRequestContext } from "@/api/mcp/context";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
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
  memberRole: sessionMemberRole("owner"),
  orgAIConfig: null,
  orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
  managedAIResidency: "eu" as const,
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

const modelCapabilityContext = (): McpRequestContext => {
  const scopedDb = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  const safeDb = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  return asTestRaw<McpRequestContext>({
    accessibleWorkspaceIds: [ids.wsA1],
    accessibleWorkspaceIdSet: new Set([ids.wsA1]),
    accessibleWorkspaceStatusById: new Map([[ids.wsA1, "active"]]),
    accessibleWorkspaces: [{ id: ids.wsA1, status: "active" }],
    createOperationDatabaseScope: () => ({
      pinServerValidatedWorkspaceId: (workspaceId) => workspaceId === ids.wsA1,
      safeDb,
      scopedDb,
    }),
    grantedScopes: ["stella:read"],
    memberRole: "owner",
    organizationId: ids.orgA,
    request: new Request("https://example.test/mcp"),
    recordAuditEvent: noopAuditRecorder,
    safeDb,
    scopedDb,
    testDependencies: {
      consumeInvokeCapabilityRateLimit: async () => ({
        ok: true,
        retryAfterSeconds: 60,
      }),
      isCapabilityFeatureEnabled: () => true,
      loadOrgSettingsForAuth: async () => ({
        orgAIConfig: null,
        orgAIConfigStatus: "ok",
        managedAIResidency: "eu",
        promptCachingEnabled: false,
      }),
    },
    userEmail: "test@example.test",
    userId: ids.userA1,
  });
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
const withheldDecision = createSafeId<"caseLawDecision">();
const withheldSource = createSafeId<"caseLawSource">();

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
  await testDb.insert(caseLawSources).values(
    caseLawSourceRow({
      adapterKey: "matter-links-withheld",
      descriptor: {
        allowsDerivedAi: false,
        allowsRedistribution: true,
        attribution: null,
        license: "permitted-redistribution",
      },
      id: withheldSource,
      name: "Matter links fixture",
    }),
  );
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
  await testDb.insert(caseLawDecisions).values({
    id: withheldDecision,
    sourceId: withheldSource,
    caseNumber: "15 Cdo 45/2024",
    slug: "15-cdo-45-2024",
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionType: "rozsudek",
    metadata: { legalSentence: "decision-summary-fixture" },
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

  test("capability results preserve the text boundary", async () => {
    await call(createMatterLink, {
      body: { decisionId: withheldDecision },
    });

    const human = await call(listMatterLinks);
    expect(human).toMatchObject({
      links: [
        {
          decision: {
            headnote: { type: "present", text: "decision-summary-fixture" },
          },
        },
      ],
    });

    const model = await call(listMatterLinks, {
      route: capabilityRoute("case-law.matter-links.list"),
    });
    expect(model).toMatchObject({
      links: [
        {
          decision: {
            caseNumber: "15 Cdo 45/2024",
            headnote: null,
            textWithheldReason: "source_licence",
          },
        },
      ],
    });
    expect(JSON.stringify(model)).not.toContain("decision-summary-fixture");

    const capabilityCall = await handleMcpToolCall({
      args: {
        capability: "case-law.matter-links.list",
        input: { params: { matterId: ids.wsA1 } },
      },
      context: modelCapabilityContext(),
      toolName: MCP_CAPABILITY_EXECUTORS.read,
    });
    const modelResult = JSON.stringify(capabilityCall);
    expect(modelResult).not.toContain("decision-summary-fixture");
    expect(modelResult).toContain('"headnote":null');
    expect(modelResult).toContain('"textWithheldReason":"source_licence"');
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
