/**
 * Saving a completed review as a playbook.
 *
 * `POST /playbooks/from-run` is root-scoped but reads a matter-scoped run, so
 * the cases that matter are the boundary ones: an unfinished run, a run in a
 * matter the caller cannot open, and — the reason the endpoint exists — that
 * the saved playbook keeps the run's position ids, which is what keeps a
 * decision taken in the run attached to the position afterwards.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import {
  documentReviewFindings,
  documentReviewRuns,
  playbookDefinitions,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import createPlaybookFromRun from "@/api/handlers/playbooks/from-run";
import getPlaybookDefinition from "@/api/handlers/playbooks/get";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ReviewPerspective } from "@/api/lib/document-review/contract";
import type {
  DocumentReviewRunBasis,
  DocumentReviewRunStatus,
} from "@/api/lib/document-review/run-contract";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

const seededRunIds: SafeId<"documentReviewRun">[] = [];
const CONTENT_SHA256 = "d".repeat(64);
const POSITION_ID = "55555555-5555-4555-8555-555555555555";
const SNAPSHOT_NAME = "Positions confirmed for this review";

const basisFor = (perspective: ReviewPerspective): DocumentReviewRunBasis => ({
  playbook: {
    definitionId: null,
    versionId: null,
    provenance: "ephemeral",
    definitionSnapshot: {
      name: SNAPSHOT_NAME,
      positions: {
        version: 3,
        items: [
          {
            mode: "graded",
            sourceId: POSITION_ID,
            issue: "Leakage time bar",
            severity: "high",
            standard: {
              source: "reference",
              passages: [
                {
                  workspaceId: Bun.randomUUIDv7(),
                  entityId: Bun.randomUUIDv7(),
                  fileFieldId: Bun.randomUUIDv7(),
                  entityVersionId: Bun.randomUUIDv7(),
                  blockId: "para-9",
                  text: "Claims must be notified within 6 months of Completion.",
                },
              ],
            },
            ask: { mode: "auto" },
            enabled: true,
          },
        ],
      },
    },
  },
  perspective,
  references: [],
});

const seedRun = async ({
  status,
  perspective,
  workspaceId = ids.wsA1,
  organizationId = ids.orgA,
}: {
  status: DocumentReviewRunStatus;
  perspective: ReviewPerspective;
  workspaceId?: SafeId<"workspace">;
  organizationId?: SafeId<"organization">;
}): Promise<SafeId<"documentReviewRun">> => {
  const runId = toSafeId<"documentReviewRun">(Bun.randomUUIDv7());
  seededRunIds.push(runId);
  await testDb.insert(documentReviewRuns).values({
    id: runId,
    organizationId,
    workspaceId,
    entityId: workspaceId === ids.wsA1 ? ids.entityA1 : ids.entityB1,
    fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
    entityVersionId:
      workspaceId === ids.wsA1 ? ids.entityVersionA1 : ids.entityVersionB1,
    contentSha256: CONTENT_SHA256,
    basis: basisFor(perspective),
    status,
    ...(status === "completed"
      ? { startedAt: new Date(), finishedAt: new Date() }
      : {}),
  });
  return runId;
};

const noopAuditRecorder: AuditRecorder = async () => undefined;

const orgContext = () => ({
  createAuditRecorder: () => noopAuditRecorder,
  getWorkspaceAccess: async (
    workspaceId: SafeId<"workspace">,
  ): Promise<AccessibleWorkspace | null> =>
    workspaceId === ids.wsA1
      ? { id: ids.wsA1, status: "active" as const }
      : null,
  memberRole: { role: "owner" as const },
  orgAIConfig: null,
  promptCachingEnabled: false,
  recordAuditEvent: noopAuditRecorder,
  request: new Request("https://example.test/playbooks/from-run"),
  route: "/playbooks/from-run",
  safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  session: { activeOrganizationId: ids.orgA },
  user: { id: ids.userA1 },
});

const runFromRun = async (body: Record<string, unknown>): Promise<unknown> => {
  try {
    return await createPlaybookFromRun.handler(
      asTestRaw<Parameters<typeof createPlaybookFromRun.handler>[0]>({
        ...orgContext(),
        body,
      }),
    );
  } catch (error) {
    return error;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const statusOf = (result: unknown): number | null => {
  if (!isRecord(result)) {
    return null;
  }
  for (const field of ["status", "statusCode", "code"] as const) {
    const value = result[field];
    if (typeof value === "number") {
      return value;
    }
  }
  return null;
};

const createdPlaybookId = (
  result: unknown,
): SafeId<"playbookDefinition"> | null => {
  if (!isRecord(result) || typeof result["id"] !== "string") {
    return null;
  }
  return toSafeId<"playbookDefinition">(result["id"]);
};

const readPlaybook = async (playbookId: SafeId<"playbookDefinition">) => {
  const rows = await testDb
    .select({
      name: playbookDefinitions.name,
      scope: playbookDefinitions.scope,
      status: playbookDefinitions.status,
      positions: playbookDefinitions.positions,
    })
    .from(playbookDefinitions)
    .where(eq(playbookDefinitions.id, playbookId));
  return rows.at(0);
};

const createdPlaybookIds: SafeId<"playbookDefinition">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    if (createdPlaybookIds.length > 0) {
      await testDb
        .delete(playbookDefinitions)
        .where(inArray(playbookDefinitions.id, createdPlaybookIds));
    }
    if (seededRunIds.length > 0) {
      await testDb
        .delete(documentReviewRuns)
        .where(inArray(documentReviewRuns.id, seededRunIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("save a completed review run as a playbook", () => {
  test("copies the run's positions verbatim and names the playbook after the document", async () => {
    const runId = await seedRun({
      status: "completed",
      perspective: { type: "party", role: "Purchaser", name: null },
    });

    const result = await runFromRun({ workspaceId: ids.wsA1, runId });
    expect(statusOf(result)).toBeNull();
    const playbookId = createdPlaybookId(result);
    expect(playbookId).not.toBeNull();
    if (playbookId === null) {
      return;
    }
    createdPlaybookIds.push(playbookId);

    const playbook = await readPlaybook(playbookId);
    // The seeded entity is named "entityA1"; the default name is the reviewed
    // document plus "review".
    expect(playbook?.name).toBe("entityA1 review");
    expect(playbook?.status).toBe("draft");
    // Purchaser is a sale side by definition, so the scope perspective is pinned.
    expect(playbook?.scope).toEqual({ perspective: "buyer" });
    // The position id survives: findings key on it, so a decision already taken
    // in the run stays attached to the position in the saved playbook.
    expect(playbook?.positions.items.map((item) => item.sourceId)).toEqual([
      POSITION_ID,
    ]);
  });

  test("leaves the scope perspective unset for a role that is not a sale side", async () => {
    const runId = await seedRun({
      status: "completed",
      perspective: { type: "party", role: "Licensee", name: "Example s.r.o." },
    });

    const result = await runFromRun({
      workspaceId: ids.wsA1,
      runId,
      name: "Licence review",
    });
    const playbookId = createdPlaybookId(result);
    expect(playbookId).not.toBeNull();
    if (playbookId === null) {
      return;
    }
    createdPlaybookIds.push(playbookId);

    const playbook = await readPlaybook(playbookId);
    expect(playbook?.name).toBe("Licence review");
    // Guessing buyer or seller here would invert every favourable/unfavourable
    // judgment a later run makes, so nothing is guessed.
    expect(playbook?.scope).toBeNull();
  });

  test("the saved playbook carries the decisions already taken on its positions", async () => {
    const runId = await seedRun({
      status: "completed",
      perspective: { type: "neutral" },
    });
    // A decision taken during the run, before any playbook existed.
    await testDb.insert(documentReviewFindings).values({
      id: toSafeId<"documentReviewFinding">(Bun.randomUUIDv7()),
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      runId,
      entityId: ids.entityA1,
      fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
      entityVersionId: ids.entityVersionA1,
      positionId: POSITION_ID,
      positionTitle: "Leakage time bar",
      outcome: "deviation",
      payload: {
        finding: {
          positionId: POSITION_ID,
          issue: "Leakage time bar",
          severity: "high",
          standardSource: "reference",
          verdict: "deviation",
          delta: { kind: "language" },
          extracted: null,
          rationale: null,
          citations: [],
          fix: {
            kind: "replaceInBlock",
            blockId: "para-4",
            find: "12 months",
            replace: "6 months",
          },
        },
      },
      decision: "accepted",
      decidedBy: ids.userA1,
      decidedAt: new Date("2026-08-20T10:00:00.000Z"),
    });

    const playbookId = createdPlaybookId(
      await runFromRun({ workspaceId: ids.wsA1, runId }),
    );
    expect(playbookId).not.toBeNull();
    if (playbookId === null) {
      return;
    }
    createdPlaybookIds.push(playbookId);

    // Reading the saved playbook shows that history, because the position id
    // was preserved rather than regenerated.
    const read = await getPlaybookDefinition.handler(
      asTestRaw<Parameters<typeof getPlaybookDefinition.handler>[0]>({
        ...orgContext(),
        params: { playbookId },
      }),
    );
    expect(statusOf(read)).toBeNull();
    expect(isRecord(read) ? read.positionDecisions : null).toEqual({
      [POSITION_ID]: {
        accepted: 1,
        dismissed: 0,
        runs: 1,
        latestAcceptedFixText: "6 months",
      },
    });
  });

  test("refuses a run that has not completed", async () => {
    const runId = await seedRun({
      status: "queued",
      perspective: { type: "neutral" },
    });

    expect(statusOf(await runFromRun({ workspaceId: ids.wsA1, runId }))).toBe(
      409,
    );
  });

  test("answers 404 for a run in a matter the caller cannot open", async () => {
    const runId = await seedRun({
      status: "completed",
      perspective: { type: "neutral" },
      workspaceId: ids.wsB1,
      organizationId: ids.orgB,
    });

    expect(statusOf(await runFromRun({ workspaceId: ids.wsB1, runId }))).toBe(
      404,
    );
  });

  test("answers 404 for a run this organization does not own", async () => {
    // The matter check passes (the caller names their own matter), so the only
    // thing standing between them and another tenant's run is the run read's
    // own workspace + organization predicate.
    const runId = await seedRun({
      status: "completed",
      perspective: { type: "neutral" },
      workspaceId: ids.wsB1,
      organizationId: ids.orgB,
    });

    expect(statusOf(await runFromRun({ workspaceId: ids.wsA1, runId }))).toBe(
      404,
    );
  });
});
