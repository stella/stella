import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { eq, inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { clauses } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { exportHandler } from "./export";
import { importHandler } from "./import";

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const seededClauseIds: SafeId<"clause">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  const scoped = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  safeDb = toSafeDbMock(asTestRaw<ScopedDb>(scoped));
});

afterAll(async () => {
  if (seededClauseIds.length > 0) {
    await testDb.delete(clauses).where(inArray(clauses.id, seededClauseIds));
  }
  await releaseRlsFixture();
});

describe("JSON and CSV Export/Import Integration", () => {
  test("exports existing clauses to CSV when requested", async () => {
    const clauseId = toSafeId<"clause">(Bun.randomUUIDv7());
    seededClauseIds.push(clauseId);

    await testDb.insert(clauses).values({
      id: clauseId,
      organizationId: ids.orgA,
      title: "Test Export Clause CSV",
      body: [{ text: "This is paragraph 1" }, { text: "This is paragraph 2" }],
      metadata: {
        version: 1,
        custom: {
          slug: "test-export-clause-csv-slug",
          tags: ["legal", "nda"],
        },
      },
      createdBy: ids.userA1,
    });

    const res = await Result.gen(() =>
      exportHandler({
        safeDb,
        organizationId: ids.orgA,
        query: { ids: clauseId, format: "csv" },
      }),
    );

    expect(Result.isError(res)).toBe(false);
    if (!Result.isError(res)) {
      const response = res.value;
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/csv");

      const csvText = await response.text();
      expect(
        csvText.includes(
          'test-export-clause-csv-slug,Test Export Clause CSV,"This is paragraph 1\nThis is paragraph 2","legal,nda"',
        ),
      ).toBe(true);
    }
  });

  test("exports existing clauses to JSON by default", async () => {
    const clauseId = toSafeId<"clause">(Bun.randomUUIDv7());
    seededClauseIds.push(clauseId);

    await testDb.insert(clauses).values({
      id: clauseId,
      organizationId: ids.orgA,
      title: "Test Export Clause JSON",
      body: [{ text: "This is paragraph 1" }],
      metadata: {
        version: 1,
        custom: {
          slug: "test-export-clause-json-slug",
          tags: ["legal"],
        },
      },
      createdBy: ids.userA1,
    });

    const res = await Result.gen(() =>
      exportHandler({
        safeDb,
        organizationId: ids.orgA,
        query: { ids: clauseId },
      }),
    );

    expect(Result.isError(res)).toBe(false);
    if (!Result.isError(res)) {
      const response = res.value;
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");

      const jsonText = await response.text();
      const payload = JSON.parse(jsonText);
      expect(payload.version).toBe(1);
      expect(payload.clauses[0].title).toBe("Test Export Clause JSON");
    }
  });

  test("imports clauses from a valid CSV", async () => {
    const csvContent = [
      "slug,title,body,tags",
      'imported-csv-slug,Imported CSV Clause 1,"Body paragraph 1\nBody paragraph 2","tag1,tag2"',
    ].join("\n");

    const file = new File([csvContent], "clauses.csv", { type: "text/csv" });
    const auditRecorder = async () => undefined;

    const res = await Result.gen(() =>
      importHandler({
        safeDb,
        organizationId: ids.orgA,
        userId: ids.userA1,
        body: { file },
        recordAuditEvent: auditRecorder,
      }),
    );

    expect(Result.isError(res)).toBe(false);
    if (!Result.isError(res)) {
      expect(res.value.created).toBe(1);

      const insertedRows = await testDb
        .select()
        .from(clauses)
        .where(eq(clauses.title, "Imported CSV Clause 1"));
      const inserted = insertedRows[0];

      expect(inserted).toBeDefined();
      if (inserted) {
        seededClauseIds.push(inserted.id);
        expect(inserted.body).toEqual([
          { text: "Body paragraph 1" },
          { text: "Body paragraph 2" },
        ]);
        expect(inserted.metadata).toMatchObject({
          version: 1,
          custom: {
            slug: "imported-csv-slug",
            tags: ["tag1", "tag2"],
          },
        });
      }
    }
  });

  test("imports clauses from a valid JSON payload", async () => {
    const jsonPayload = {
      version: 1,
      exportedAt: "2026-07-26T00:00:00Z",
      clauses: [
        {
          title: "Imported JSON Clause 1",
          description: "A description",
          usageNotes: "Usage notes",
          language: "en",
          body: [{ text: "JSON Body paragraph 1" }],
          metadata: {
            version: 1,
            custom: {
              slug: "imported-json-slug",
              tags: ["tag-json"],
            },
          },
          categoryName: "Contracts",
          categoryPath: ["Contracts"],
        },
      ],
    };

    const file = new File([JSON.stringify(jsonPayload)], "clauses.json", {
      type: "application/json",
    });
    const auditRecorder = async () => undefined;

    const res = await Result.gen(() =>
      importHandler({
        safeDb,
        organizationId: ids.orgA,
        userId: ids.userA1,
        body: { file },
        recordAuditEvent: auditRecorder,
      }),
    );

    expect(Result.isError(res)).toBe(false);
    if (!Result.isError(res)) {
      expect(res.value.created).toBe(1);

      const insertedRows = await testDb
        .select()
        .from(clauses)
        .where(eq(clauses.title, "Imported JSON Clause 1"));
      const inserted = insertedRows[0];

      expect(inserted).toBeDefined();
      if (inserted) {
        seededClauseIds.push(inserted.id);
        expect(inserted.body).toEqual([{ text: "JSON Body paragraph 1" }]);
        expect(inserted.metadata).toMatchObject({
          version: 1,
          custom: {
            slug: "imported-json-slug",
            tags: ["tag-json"],
          },
        });
      }
    }
  });

  test("rejects CSV with missing required headers", async () => {
    const csvContent = ["title,body", 'Imported Clause 1,"Body paragraph 1"'].join(
      "\n",
    );

    const file = new File([csvContent], "clauses.csv", { type: "text/csv" });
    const auditRecorder = async () => undefined;

    const res = await Result.gen(() =>
      importHandler({
        safeDb,
        organizationId: ids.orgA,
        userId: ids.userA1,
        body: { file },
        recordAuditEvent: auditRecorder,
      }),
    );

    expect(Result.isError(res)).toBe(true);
    if (Result.isError(res)) {
      expect(res.error).toMatchObject({
        status: 400,
      });
      expect(res.error.message).toContain("Missing required CSV headers");
    }
  });

  test("rejects invalid JSON payload", async () => {
    const file = new File([JSON.stringify({ bad: "format" })], "clauses.json", {
      type: "application/json",
    });
    const auditRecorder = async () => undefined;

    const res = await Result.gen(() =>
      importHandler({
        safeDb,
        organizationId: ids.orgA,
        userId: ids.userA1,
        body: { file },
        recordAuditEvent: auditRecorder,
      }),
    );

    expect(Result.isError(res)).toBe(true);
    if (Result.isError(res)) {
      expect(res.error).toMatchObject({
        status: 400,
      });
      expect(res.error.message).toContain("Invalid clause export format");
    }
  });
});
