import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { clauseCategories, clauses } from "@/api/db/schema";
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
const seededCategoryIds: SafeId<"clauseCategory">[] = [];

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
  if (seededCategoryIds.length > 0) {
    await testDb
      .delete(clauseCategories)
      .where(inArray(clauseCategories.id, seededCategoryIds));
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

  test("roundtrips comma and backslash characters inside tags", async () => {
    const clauseId = toSafeId<"clause">(Bun.randomUUIDv7());
    seededClauseIds.push(clauseId);

    await testDb.insert(clauses).values({
      id: clauseId,
      organizationId: ids.orgA,
      title: "CSV Tag Roundtrip Clause",
      body: [{ text: "First paragraph" }, { text: "Second paragraph" }],
      metadata: {
        version: 1,
        custom: {
          slug: "csv-tag-roundtrip",
          tags: ["civil, commercial", String.raw`path\segment`],
        },
      },
      createdBy: ids.userA1,
    });

    const exportResult = await Result.gen(() =>
      exportHandler({
        safeDb,
        organizationId: ids.orgA,
        query: { ids: clauseId, format: "csv" },
      }),
    );
    expect(Result.isError(exportResult)).toBe(false);
    if (Result.isError(exportResult)) {
      return;
    }

    const file = new File(
      [await exportResult.value.text()],
      "clauses-roundtrip.csv",
      { type: "text/csv" },
    );
    const importResult = await Result.gen(() =>
      importHandler({
        safeDb,
        organizationId: ids.orgA,
        userId: ids.userA1,
        body: { file },
        recordAuditEvent: async () => undefined,
      }),
    );
    expect(Result.isError(importResult)).toBe(false);
    if (Result.isError(importResult)) {
      return;
    }

    expect(importResult.value.created).toBe(1);
    const rows = await testDb
      .select()
      .from(clauses)
      .where(eq(clauses.title, "CSV Tag Roundtrip Clause"));
    const imported = rows.find((row) => row.id !== clauseId);
    expect(imported).toBeDefined();
    if (!imported) {
      return;
    }

    seededClauseIds.push(imported.id);
    expect(imported.body).toEqual([
      { text: "First paragraph" },
      { text: "Second paragraph" },
    ]);
    expect(imported.metadata).toMatchObject({
      version: 1,
      custom: {
        slug: "csv-tag-roundtrip",
        tags: ["civil, commercial", String.raw`path\segment`],
      },
    });
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
          categoryName: "Imported JSON Contracts",
          categoryPath: ["Imported JSON Contracts"],
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

      const importedCategories = await testDb
        .select({ id: clauseCategories.id })
        .from(clauseCategories)
        .where(eq(clauseCategories.name, "Imported JSON Contracts"));
      const importedCategory = importedCategories.at(0);
      if (importedCategory) {
        seededCategoryIds.push(importedCategory.id);
      }
    }
  });

  test("rejects CSV with missing required headers", async () => {
    const csvContent = [
      "title,body",
      'Imported Clause 1,"Body paragraph 1"',
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

    expect(Result.isError(res)).toBe(true);
    if (Result.isError(res)) {
      expect(res.error).toMatchObject({
        status: 400,
      });
      expect(res.error.message).toContain("Missing required CSV headers");
    }
  });

  test("rejects unterminated quoted CSV without inserting a clause", async () => {
    const file = new File(
      [
        [
          "slug,title,body,tags",
          'first,Malformed CSV Clause,"Body',
          "second,Absorbed Clause,Body,tag",
        ].join("\n"),
      ],
      "clauses.csv",
      { type: "text/csv" },
    );

    const result = await Result.gen(() =>
      importHandler({
        safeDb,
        organizationId: ids.orgA,
        userId: ids.userA1,
        body: { file },
        recordAuditEvent: async () => undefined,
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (!Result.isError(result)) {
      return;
    }
    expect(result.error).toMatchObject({
      status: 400,
      message: "Invalid CSV file",
    });

    const rows = await testDb
      .select({ id: clauses.id })
      .from(clauses)
      .where(eq(clauses.title, "Malformed CSV Clause"));
    expect(rows).toEqual([]);
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
