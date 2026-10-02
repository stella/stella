import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { clauses, clauseVersions } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ClauseBody } from "@/api/lib/clauses/types";
import { LIMITS } from "@/api/lib/limits";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { updateClauseHandler } from "./update";

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const clauseIds: SafeId<"clause">[] = [];
const initialBody: ClauseBody = [{ text: "Initial text" }];
const nextBody: ClauseBody = [{ text: "Next text" }];

beforeAll(async () => {
  ({ testDb, ids } = await getRlsFixture());
  safeDb = toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    ),
  );
});

afterAll(async () => {
  if (clauseIds.length > 0) {
    await testDb.delete(clauses).where(inArray(clauses.id, clauseIds));
  }
  await releaseRlsFixture();
});

const seedClause = async (body: ClauseBody = initialBody) => {
  const clauseId = createSafeId<"clause">();
  clauseIds.push(clauseId);
  await testDb.insert(clauses).values({
    id: clauseId,
    organizationId: ids.orgA,
    title: "Clause precondition",
    body,
    createdBy: ids.userA1,
  });
  return clauseId;
};

describe("clause body preconditions", () => {
  test("clause body preconditions preserve paragraph content and order", async () => {
    await assertProperty(
      "clause body preconditions preserve paragraph content and order",
      fc.asyncProperty(
        fc.array(
          fc.record({
            text: fc
              .array(fc.constantFrom("a", "Ž", "č", "漢", "é", " ", "\n"), {
                maxLength: 30,
              })
              .map((characters) => characters.join("")),
            style: fc.constantFrom("Normal", "Heading", "Nadpis"),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        async (paragraphs) => {
          const clauseId = await seedClause(paragraphs);
          const expectedBody = paragraphs.map(({ text, style }) => ({
            style,
            text,
          }));
          const changedBody = [...paragraphs, { text: "Appended paragraph" }];
          const saved = await Result.gen(() =>
            updateClauseHandler({
              safeDb,
              organizationId: ids.orgA,
              clauseId,
              body: { body: changedBody, expectedBody },
              recordAuditEvent: async () => undefined,
            }),
          );
          expect(Result.isOk(saved)).toBe(true);
          const refused = await Result.gen(() =>
            updateClauseHandler({
              safeDb,
              organizationId: ids.orgA,
              clauseId,
              body: { body: paragraphs, expectedBody },
              recordAuditEvent: async () => undefined,
            }),
          );
          expect(Result.isError(refused)).toBe(true);
          if (Result.isError(refused)) {
            expect(refused.error).toMatchObject({ status: 409 });
          }
          expect(
            (
              await testDb.query.clauses.findFirst({
                where: { id: { eq: clauseId } },
              })
            )?.body,
          ).toEqual(changedBody);
        },
      ),
      { numRuns: 15 },
    );
  });

  test.each([false, true])(
    "stale precondition leaves head, history and audit unchanged (snapshot %s)",
    async (snapshotVersion) => {
      const clauseId = await seedClause();
      const before = await testDb.query.clauses.findFirst({
        where: { id: { eq: clauseId } },
      });
      let audits = 0;
      const result = await Result.gen(() =>
        updateClauseHandler({
          safeDb,
          organizationId: ids.orgA,
          clauseId,
          body: {
            body: nextBody,
            expectedBody: [{ text: "Older text" }],
            snapshotVersion,
            title: "Changed title",
          },
          recordAuditEvent: async () => {
            audits += 1;
          },
        }),
      );
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error).toMatchObject({ status: 409 });
      }
      expect(
        await testDb.query.clauses.findFirst({
          where: { id: { eq: clauseId } },
        }),
      ).toEqual(before);
      expect(
        await testDb.$count(
          clauseVersions,
          eq(clauseVersions.clauseId, clauseId),
        ),
      ).toBe(0);
      expect(audits).toBe(0);
    },
  );

  test.each(["matching", "omitted"] as const)(
    "%s precondition writes head and snapshot",
    async (precondition) => {
      const clauseId = await seedClause();
      let audits = 0;
      const result = await Result.gen(() =>
        updateClauseHandler({
          safeDb,
          organizationId: ids.orgA,
          clauseId,
          body: {
            body: nextBody,
            snapshotVersion: true,
            ...(precondition === "matching"
              ? { expectedBody: initialBody }
              : {}),
          },
          recordAuditEvent: async () => {
            audits += 1;
          },
        }),
      );
      expect(Result.isOk(result)).toBe(true);
      const head = await testDb.query.clauses.findFirst({
        where: { id: { eq: clauseId } },
      });
      expect(head?.body).toEqual(nextBody);
      expect(head?.currentVersion).toBe(2);
      const versions = await testDb.query.clauseVersions.findMany({
        where: { clauseId: { eq: clauseId } },
      });
      expect(versions).toHaveLength(1);
      expect(versions.at(0)?.body).toEqual(nextBody);
      expect(audits).toBe(1);
    },
  );

  test("matching rich paragraphs are independent of object key order", async () => {
    const storedBody: ClauseBody = [
      {
        text: "Formatted text",
        style: "Heading",
        runs: [{ text: "Formatted text", bold: true }],
      },
    ];
    const expectedBody: ClauseBody = [
      {
        runs: [{ bold: true, text: "Formatted text" }],
        style: "Heading",
        text: "Formatted text",
      },
    ];
    expect(JSON.stringify(storedBody)).not.toBe(JSON.stringify(expectedBody));
    const clauseId = await seedClause(storedBody);
    const result = await Result.gen(() =>
      updateClauseHandler({
        safeDb,
        organizationId: ids.orgA,
        clauseId,
        body: { body: nextBody, expectedBody },
        recordAuditEvent: async () => undefined,
      }),
    );
    expect(Result.isOk(result)).toBe(true);
    expect(
      (
        await testDb.query.clauses.findFirst({
          where: { id: { eq: clauseId } },
        })
      )?.body,
    ).toEqual(nextBody);
  });

  test("metadata-only writes also honor the body precondition", async () => {
    const clauseId = await seedClause();
    let audits = 0;
    const result = await Result.gen(() =>
      updateClauseHandler({
        safeDb,
        organizationId: ids.orgA,
        clauseId,
        body: { title: "Changed title", expectedBody: nextBody },
        recordAuditEvent: async () => {
          audits += 1;
        },
      }),
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ status: 409 });
    }
    expect(
      (
        await testDb.query.clauses.findFirst({
          where: { id: { eq: clauseId } },
        })
      )?.title,
    ).toBe("Clause precondition");
    expect(audits).toBe(0);
  });

  test("the version cap refuses new snapshots and permits equivalent snapshots", async () => {
    const clauseId = await seedClause();
    await testDb.insert(clauseVersions).values(
      Array.from({ length: LIMITS.clauseVersionsPerClause }, (_, index) => ({
        id: createSafeId<"clauseVersion">(),
        organizationId: ids.orgA,
        clauseId,
        version: index + 1,
        body: initialBody,
      })),
    );
    await testDb
      .update(clauses)
      .set({ currentVersion: LIMITS.clauseVersionsPerClause })
      .where(eq(clauses.id, clauseId));
    let audits = 0;
    const refused = await Result.gen(() =>
      updateClauseHandler({
        safeDb,
        organizationId: ids.orgA,
        clauseId,
        body: {
          body: nextBody,
          expectedBody: initialBody,
          snapshotVersion: true,
        },
        recordAuditEvent: async () => {
          audits += 1;
        },
      }),
    );
    expect(Result.isError(refused)).toBe(true);
    if (Result.isError(refused)) {
      expect(refused.error).toMatchObject({
        status: 400,
        message: "Version limit reached for this clause",
      });
    }
    expect(audits).toBe(0);
    expect(
      (
        await testDb.query.clauses.findFirst({
          where: { id: { eq: clauseId } },
        })
      )?.body,
    ).toEqual(initialBody);
    const equivalent = await Result.gen(() =>
      updateClauseHandler({
        safeDb,
        organizationId: ids.orgA,
        clauseId,
        body: {
          body: initialBody,
          expectedBody: initialBody,
          snapshotVersion: true,
        },
        recordAuditEvent: async () => {
          audits += 1;
        },
      }),
    );
    expect(Result.isOk(equivalent)).toBe(true);
    expect(
      await testDb.$count(
        clauseVersions,
        eq(clauseVersions.clauseId, clauseId),
      ),
    ).toBe(LIMITS.clauseVersionsPerClause);
    expect(audits).toBe(1);
  });
});
