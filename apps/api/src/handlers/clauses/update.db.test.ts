import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { clauses, clauseVersions } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ClauseBody } from "@/api/lib/clauses/types";
import { LIMITS } from "@/api/lib/limits";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { getClauseHandler } from "./read";
import updateClause, { updateClauseHandler } from "./update";
import restoreClauseVersion from "./versions/restore";

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
  test("restore honors its precondition and returns the audited server head", async () => {
    const clauseId = await seedClause();
    const versionId = createSafeId<"clauseVersion">();
    await testDb.insert(clauseVersions).values({
      id: versionId,
      organizationId: ids.orgA,
      clauseId,
      version: 1,
      body: nextBody,
    });
    const audits: AuditEvent[] = [];
    const restore = async (expectedBody: ClauseBody) =>
      await restoreClauseVersion.handler(
        createTestHandlerContext<
          Parameters<typeof restoreClauseVersion.handler>[0]
        >({
          safeDb,
          session: { activeOrganizationId: ids.orgA },
          user: { id: ids.userA1 },
          params: { clauseId, versionId },
          body: { expectedBody },
          recordAuditEvent: async (_tx, event) => {
            audits.push(event);
          },
        }),
      );
    expect(await restore([{ text: "Older" }])).toMatchObject({ code: 409 });
    expect(audits).toHaveLength(0);
    expect(
      (
        await testDb.query.clauses.findFirst({
          where: { id: { eq: clauseId } },
        })
      )?.body,
    ).toEqual(initialBody);
    expect(
      await testDb.$count(
        clauseVersions,
        eq(clauseVersions.clauseId, clauseId),
      ),
    ).toBe(1);
    expect(await restore(initialBody)).toMatchObject({
      body: nextBody,
      currentVersion: 2,
      updatedAt: expect.any(Date),
    });
    expect(audits).toHaveLength(1);
    expect(audits.at(0)?.changes).toMatchObject({
      restoredFromVersion: { new: 1 },
    });
  });

  test("a committed snapshot can be replayed with the original precondition", async () => {
    const clauseId = await seedClause();
    const replay = () =>
      updateClauseHandler({
        safeDb,
        organizationId: ids.orgA,
        clauseId,
        body: {
          body: nextBody,
          expectedBody: initialBody,
          snapshotVersion: true,
        },
        recordAuditEvent: async () => undefined,
      });
    for (let request = 0; request < 2; request += 1) {
      const result = await Result.gen(replay);
      expect(Result.isOk(result)).toBe(true);
    }
    expect(
      await testDb.$count(
        clauseVersions,
        eq(clauseVersions.clauseId, clauseId),
      ),
    ).toBe(1);
    expect(
      (
        await testDb.query.clauses.findFirst({
          where: { id: { eq: clauseId } },
        })
      )?.body,
    ).toEqual(nextBody);
  });

  test("HTTP read bodies remain valid preconditions after import", async () => {
    const importedBody = [
      {
        text: "List text",
        listKind: "bullet",
        listLevel: 1,
        style: null,
        level: "wrong",
        extra: "extension",
      },
      {
        text: "{% if party %}",
        isDirective: true,
        directiveKind: "if",
        directiveExpression: "party",
        runs: [{ text: "{% if party %}", bold: null }],
      },
    ];
    const clauseId = await seedClause(asTestRaw<ClauseBody>(importedBody));
    const app = new Elysia()
      .get("/clause", async () => {
        const result = await Result.gen(() =>
          getClauseHandler({ safeDb, organizationId: ids.orgA, clauseId }),
        );
        return result.unwrap();
      })
      .post(
        "/clause",
        async ({ body, set }) => {
          const result = await Result.gen(() =>
            updateClauseHandler({
              safeDb,
              organizationId: ids.orgA,
              clauseId,
              body,
              recordAuditEvent: async () => undefined,
            }),
          );
          if (Result.isError(result)) {
            set.status = result.error.status;
            return { message: result.error.message };
          }
          return result.value;
        },
        { body: updateClause.config.body },
      );
    const readResponse = await app.handle(
      new Request("http://localhost/clause"),
    );
    expect(readResponse.status).toBe(200);
    const read = await readResponse.json();
    expect(read.body).toEqual([
      { text: "List text", listKind: "bullet", listLevel: 1 },
      {
        text: "{% if party %}",
        isDirective: true,
        directiveKind: "if",
        directiveExpression: "party",
        runs: [{ text: "{% if party %}" }],
      },
    ]);
    const rawPreconditionResponse = await app.handle(
      new Request("http://localhost/clause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usageNotes: "Notes",
          expectedBody: importedBody,
        }),
      }),
    );
    expect(rawPreconditionResponse.status).toBe(200);
    const invalidBodyResponse = await app.handle(
      new Request("http://localhost/clause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: importedBody, expectedBody: read.body }),
      }),
    );
    expect(invalidBodyResponse.status).toBe(422);
    const savedResponse = await app.handle(
      new Request("http://localhost/clause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: nextBody, expectedBody: read.body }),
      }),
    );
    expect(savedResponse.status).toBe(200);
    expect(
      (
        await testDb.query.clauses.findFirst({
          where: { id: { eq: clauseId } },
        })
      )?.body,
    ).toEqual(nextBody);
  });

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

  test("restore at the version cap keeps the working body and history unchanged", async () => {
    const clauseId = await seedClause(nextBody);
    const versionIds = Array.from(
      { length: LIMITS.clauseVersionsPerClause },
      () => createSafeId<"clauseVersion">(),
    );
    await testDb.insert(clauseVersions).values(
      versionIds.map((id, index) => ({
        id,
        organizationId: ids.orgA,
        clauseId,
        version: index + 1,
        body: initialBody,
      })),
    );
    const versionId = versionIds.at(0);
    if (!versionId) {
      throw new Error("Expected a stored version");
    }
    const before = await testDb.query.clauses.findFirst({
      where: { id: { eq: clauseId } },
    });
    let audits = 0;
    const result = await restoreClauseVersion.handler(
      createTestHandlerContext<
        Parameters<typeof restoreClauseVersion.handler>[0]
      >({
        safeDb,
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        params: { clauseId, versionId },
        body: { expectedBody: nextBody },
        recordAuditEvent: async () => {
          audits += 1;
        },
      }),
    );
    expect(result).toMatchObject({ code: 400 });
    expect(
      await testDb.query.clauses.findFirst({ where: { id: { eq: clauseId } } }),
    ).toEqual(before);
    expect(
      await testDb.$count(
        clauseVersions,
        eq(clauseVersions.clauseId, clauseId),
      ),
    ).toBe(LIMITS.clauseVersionsPerClause);
    expect(audits).toBe(0);
  });
});
