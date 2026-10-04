/**
 * A run's pinned positions as each reader sees them. A reference position's
 * prose was written from another matter's document, so it reaches a reader
 * only when that reader can open every matter the position's passages came
 * from: in the point read, in the history list's newest run, and in the
 * export.
 *
 * Whole responses are searched for the marker, not one field, so a copy of the
 * prose anywhere in the payload fails the test.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { documentReviewRuns } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { DocumentReviewRunBasis } from "@/api/lib/document-review/run-contract";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { Position } from "@/api/lib/workflow/playbook-positions";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import exportDocumentReviewRun from "./export-run";
import listDocumentReviewRuns from "./list-runs";
import readDocumentReviewRun from "./read-run";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

const seededRunIds: SafeId<"documentReviewRun">[] = [];

const MARKER = "MARKER-24-MONTH-LIMITATION";

const passageIn = (workspaceId: string) => ({
  id: Bun.randomUUIDv7(),
  workspaceId,
  entityId: Bun.randomUUIDv7(),
  fileFieldId: Bun.randomUUIDv7(),
  entityVersionId: Bun.randomUUIDv7(),
  blockId: "p1",
});

const referencePosition = (
  workspaceIds: readonly string[],
  marker: string,
): Position => ({
  mode: "graded",
  sourceId: Bun.randomUUIDv7(),
  issue: "Time bar",
  severity: "high",
  standard: {
    source: "reference",
    termKind: "parameter",
    passages: workspaceIds.map(passageIn),
  },
  ask: { mode: "auto" },
  purpose: `Purpose ${marker}`,
  guidance: `Compare the time bar with ${marker}`,
  negotiation: {
    rationale: `Rationale ${marker}`,
    talkingPoints: [`Point ${marker}`],
    escalation: `Escalate ${marker}`,
  },
  enabled: true,
});

const basisWith = (
  positions: Position[],
  referenceWorkspaceId: SafeId<"workspace">,
): DocumentReviewRunBasis => ({
  playbook: {
    definitionId: null,
    versionId: null,
    provenance: "ephemeral",
    definitionSnapshot: {
      name: "Positions confirmed for this review",
      positions: { version: 3, items: positions },
    },
  },
  references: [
    {
      workspaceId: referenceWorkspaceId,
      workspaceName: "Reference matter",
      entityId: toSafeId<"entity">(Bun.randomUUIDv7()),
      fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
      entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
      contentSha256: "b".repeat(64),
      name: "Reference.docx",
    },
  ],
  perspective: { type: "neutral" },
});

const seedRun = async (
  basis: DocumentReviewRunBasis,
): Promise<SafeId<"documentReviewRun">> => {
  const runId = toSafeId<"documentReviewRun">(Bun.randomUUIDv7());
  seededRunIds.push(runId);
  await testDb.insert(documentReviewRuns).values({
    id: runId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    entityId: ids.entityA1,
    fileFieldId: ids.fieldA1,
    entityVersionId: ids.entityVersionA1,
    contentSha256: "a".repeat(64),
    basis,
    // Terminal, so several runs may sit on one document; the basis is pinned
    // from creation, so what a reader sees does not depend on progress.
    status: "completed",
    total: 0,
    completed: 0,
    finishedAt: new Date(),
    requestedBy: ids.userA1,
  });
  return runId;
};

/** A reader of the run's matter who can also open `extra` matters. */
const readerOf = (extra: SafeId<"workspace">[]): SafeDb =>
  asTestRaw<SafeDb>(
    createSafeDb(testDb, [ids.wsA1, ...extra], ids.orgA, ids.userA1),
  );

const handlerContext = (safeDb: SafeDb, rest: Record<string, unknown>) => ({
  memberRole: sessionMemberRole("member"),
  recordAuditEvent: auditRecorderDouble(),
  safeDb,
  session: { activeOrganizationId: ids.orgA },
  user: { id: ids.userA1 },
  workspaceId: ids.wsA1,
  ...rest,
});

const pointRead = async (
  safeDb: SafeDb,
  runId: SafeId<"documentReviewRun">,
): Promise<string> =>
  JSON.stringify(
    await readDocumentReviewRun.handler(
      asTestRaw<Parameters<typeof readDocumentReviewRun.handler>[0]>(
        handlerContext(safeDb, {
          params: { workspaceId: ids.wsA1, runId },
        }),
      ),
    ),
  );

/** The history list with its newest run in full, which must be `runId`. */
const latestRead = async (
  safeDb: SafeDb,
  runId: SafeId<"documentReviewRun">,
): Promise<string> => {
  const body = JSON.stringify(
    await listDocumentReviewRuns.handler(
      asTestRaw<Parameters<typeof listDocumentReviewRuns.handler>[0]>(
        handlerContext(safeDb, {
          params: { workspaceId: ids.wsA1 },
          query: {
            entityId: ids.entityA1,
            fileFieldId: ids.fieldA1,
            includeLatest: true,
          },
        }),
      ),
    ),
  );
  expect(JSON.parse(body)).toMatchObject({ latest: { run: { id: runId } } });
  return body;
};

const exportRead = async (
  safeDb: SafeDb,
  runId: SafeId<"documentReviewRun">,
): Promise<string> => {
  const response = await exportDocumentReviewRun.handler(
    asTestRaw<Parameters<typeof exportDocumentReviewRun.handler>[0]>(
      handlerContext(safeDb, {
        params: { workspaceId: ids.wsA1, runId },
        query: { format: "csv" },
      }),
    ),
  );
  if (!(response instanceof Response)) {
    throw new TypeError(
      `expected an export response: ${JSON.stringify(response)}`,
    );
  }
  return await response.text();
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    if (seededRunIds.length > 0) {
      await testDb
        .delete(documentReviewRuns)
        .where(inArray(documentReviewRuns.id, seededRunIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("a run's pinned positions for each reader", () => {
  test("withholds reference prose from a reader who cannot open the reference matter", async () => {
    const runId = await seedRun(
      basisWith([referencePosition([ids.wsA2], MARKER)], ids.wsA2),
    );
    const reader = readerOf([]);

    for (const body of [
      await pointRead(reader, runId),
      await latestRead(reader, runId),
      await exportRead(reader, runId),
    ]) {
      expect(body).not.toContain(MARKER);
    }
    const detail = JSON.parse(await pointRead(reader, runId));
    expect(
      detail.run.basis.playbook.definitionSnapshot.positions.items,
    ).toMatchObject([{ issue: "Time bar", referenceDetail: "withheld" }]);
  });

  test("shows reference prose to a reader who can open every reference matter", async () => {
    const runId = await seedRun(
      basisWith([referencePosition([ids.wsA2], MARKER)], ids.wsA2),
    );
    const reader = readerOf([ids.wsA2]);

    expect(await pointRead(reader, runId)).toContain(MARKER);
    expect(await latestRead(reader, runId)).toContain(MARKER);
    expect(await pointRead(reader, runId)).not.toContain('"withheld"');
  });

  test("withholds the prose again once access to the reference matter is gone", async () => {
    const runId = await seedRun(
      basisWith([referencePosition([ids.wsA2], MARKER)], ids.wsA2),
    );

    expect(await pointRead(readerOf([ids.wsA2]), runId)).toContain(MARKER);
    expect(await pointRead(readerOf([]), runId)).not.toContain(MARKER);
  });

  test("decides per position, and needs every matter a position's passages came from", async () => {
    const ownMatterMarker = "MARKER-OWN-MATTER";
    const runId = await seedRun(
      basisWith(
        [
          referencePosition([ids.wsA1, ids.wsA2], MARKER),
          referencePosition([ids.wsA1], ownMatterMarker),
        ],
        ids.wsA2,
      ),
    );
    const body = await pointRead(readerOf([]), runId);

    expect(body).not.toContain(MARKER);
    expect(body).toContain(ownMatterMarker);
  });
});
