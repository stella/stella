import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  clauses,
  clauseVersions,
  templateClauses,
  templates,
} from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ClauseBody } from "@/api/lib/clauses/types";
import { syncAllClausesHandler } from "@/api/lib/template-clause-links";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * The bulk sync repoints every outdated link with one values-join update.
 * Hand-assembled SQL is unreviewable until something executes it: a missing
 * cast or a join condition on the wrong column is a runtime error no unit test
 * reaches. This runs the real statement over two outdated links, one current
 * link, and a link on a second template that must not move.
 */

setDefaultTimeout(120_000);

let testDb: TestDatabase;

const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
const userId = `user_${Bun.randomUUIDv7()}`;
const templateId = createSafeId<"template">();
const otherTemplateId = createSafeId<"template">();

type SeededClause = {
  clauseId: SafeId<"clause">;
  staleVersionId: SafeId<"clauseVersion">;
  currentVersionId: SafeId<"clauseVersion">;
};

const newClauseIds = (): SeededClause => ({
  clauseId: createSafeId<"clause">(),
  staleVersionId: createSafeId<"clauseVersion">(),
  currentVersionId: createSafeId<"clauseVersion">(),
});

const seeded: Record<"alpha" | "beta" | "gamma", SeededClause> = {
  alpha: newClauseIds(),
  beta: newClauseIds(),
  gamma: newClauseIds(),
};

const clauseBody: ClauseBody = [{ text: "Governing law." }];

const linkIds = {
  alphaOutdated: createSafeId<"templateClause">(),
  betaOutdated: createSafeId<"templateClause">(),
  gammaCurrent: createSafeId<"templateClause">(),
  alphaOnOtherTemplate: createSafeId<"templateClause">(),
};

const scopedDb: ScopedDb = async (callback) =>
  await testDb.transaction(async (tx) => {
    await tx.execute(sql.raw("RESET ROLE"));
    return await callback(asTestRaw<Transaction>(tx));
  });

const noAuditRows: AuditRecorder = async () => undefined;

const template = (id: SafeId<"template">, name: string) => ({
  id,
  organizationId,
  name,
  fileName: `${name}.docx`,
  s3Key: `templates/${id}.docx`,
  sizeBytes: 1,
  createdBy: userId,
});

const clauseRow = (clause: SeededClause, title: string) => ({
  id: clause.clauseId,
  organizationId,
  title,
  body: clauseBody,
  // Version 2 is current, so a link pinned to version 1 is outdated.
  currentVersion: 2,
  createdBy: userId,
});

const versionRows = (clause: SeededClause) => [
  {
    id: clause.staleVersionId,
    organizationId,
    clauseId: clause.clauseId,
    version: 1,
    body: clauseBody,
  },
  {
    id: clause.currentVersionId,
    organizationId,
    clauseId: clause.clauseId,
    version: 2,
    body: clauseBody,
  },
];

beforeAll(async () => {
  testDb = await getTestDb();

  await testDb.transaction(async (tx) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.insert(organization).values({
      id: organizationId,
      name: "Clause sync firm",
      slug: organizationId,
      createdAt: new Date(),
    });
    await tx.insert(user).values({
      id: userId,
      name: "Clause sync user",
      email: `${userId}@test.local`,
    });
    await tx
      .insert(templates)
      .values([
        template(templateId, "engagement-letter"),
        template(otherTemplateId, "nda"),
      ]);
    await tx
      .insert(clauses)
      .values([
        clauseRow(seeded.alpha, "Alpha"),
        clauseRow(seeded.beta, "Beta"),
        clauseRow(seeded.gamma, "Gamma"),
      ]);
    await tx
      .insert(clauseVersions)
      .values([
        ...versionRows(seeded.alpha),
        ...versionRows(seeded.beta),
        ...versionRows(seeded.gamma),
      ]);
    await tx.insert(templateClauses).values([
      {
        id: linkIds.alphaOutdated,
        organizationId,
        templateId,
        clauseId: seeded.alpha.clauseId,
        clauseVersionId: seeded.alpha.staleVersionId,
        sortOrder: 0,
      },
      {
        id: linkIds.betaOutdated,
        organizationId,
        templateId,
        clauseId: seeded.beta.clauseId,
        clauseVersionId: seeded.beta.staleVersionId,
        sortOrder: 1,
      },
      {
        id: linkIds.gammaCurrent,
        organizationId,
        templateId,
        clauseId: seeded.gamma.clauseId,
        clauseVersionId: seeded.gamma.currentVersionId,
        sortOrder: 2,
      },
      {
        // Same clause, different template: the statement's template check is
        // the only thing that keeps this pin where it is.
        id: linkIds.alphaOnOtherTemplate,
        organizationId,
        templateId: otherTemplateId,
        clauseId: seeded.alpha.clauseId,
        clauseVersionId: seeded.alpha.staleVersionId,
        sortOrder: 0,
      },
    ]);
  });
});

afterAll(async () => {
  await testDb.transaction(async (tx) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx
      .delete(templateClauses)
      .where(eq(templateClauses.organizationId, organizationId));
    await tx
      .delete(templates)
      .where(inArray(templates.id, [templateId, otherTemplateId]));
    await tx.delete(clauses).where(eq(clauses.organizationId, organizationId));
    await tx.delete(organization).where(eq(organization.id, organizationId));
    await tx.delete(user).where(eq(user.id, userId));
  });
  await releaseTestDb();
});

const pinnedVersionByLinkId = async () => {
  const rows = await testDb
    .select({
      id: templateClauses.id,
      clauseVersionId: templateClauses.clauseVersionId,
    })
    .from(templateClauses)
    .where(eq(templateClauses.organizationId, organizationId));
  return new Map(rows.map((row) => [row.id, row.clauseVersionId]));
};

const syncTemplate = async () =>
  await syncAllClausesHandler({
    scopedDb,
    organizationId,
    templateId,
    recordAuditEvent: noAuditRows,
  });

/**
 * The sync mutates the seeded pins, so each test starts from the same state
 * rather than from whatever the previous one left. Otherwise a test passes
 * only in file order and fails when run alone under a name filter.
 */
beforeEach(async () => {
  const stalePins: [SafeId<"templateClause">, SafeId<"clauseVersion">][] = [
    [linkIds.alphaOutdated, seeded.alpha.staleVersionId],
    [linkIds.betaOutdated, seeded.beta.staleVersionId],
    [linkIds.gammaCurrent, seeded.gamma.currentVersionId],
    [linkIds.alphaOnOtherTemplate, seeded.alpha.staleVersionId],
  ];
  await testDb.transaction(async (tx) => {
    await tx.execute(sql.raw("RESET ROLE"));
    for (const [linkId, clauseVersionId] of stalePins) {
      await tx
        .update(templateClauses)
        .set({ clauseVersionId })
        .where(eq(templateClauses.id, linkId));
    }
  });
});

test("one statement repoints every outdated link on the template", async () => {
  expect(await syncTemplate()).toEqual({ syncedCount: 2 });

  const pinned = await pinnedVersionByLinkId();
  expect(pinned.get(linkIds.alphaOutdated)).toBe(seeded.alpha.currentVersionId);
  expect(pinned.get(linkIds.betaOutdated)).toBe(seeded.beta.currentVersionId);

  // Already current, so it was never in the statement.
  expect(pinned.get(linkIds.gammaCurrent)).toBe(seeded.gamma.currentVersionId);

  // The same clause on another template keeps its stale pin: the update's
  // template check is what confines the values join.
  expect(pinned.get(linkIds.alphaOnOtherTemplate)).toBe(
    seeded.alpha.staleVersionId,
  );
});

// Idempotence is a property of a sync that follows a sync, so this establishes
// its own precondition instead of inheriting one from the test above.
test("a sync after a sync finds nothing left to repoint", async () => {
  expect(await syncTemplate()).toEqual({ syncedCount: 2 });

  expect(await syncTemplate()).toEqual({ syncedCount: 0 });

  const pinned = await pinnedVersionByLinkId();
  expect(pinned.get(linkIds.alphaOutdated)).toBe(seeded.alpha.currentVersionId);
  expect(pinned.get(linkIds.betaOutdated)).toBe(seeded.beta.currentVersionId);
});
