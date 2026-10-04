import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import fc from "fast-check";
import JSZip from "jszip";

import { CLAUSE_VERSION_LIMIT_ERROR_CODE } from "@stll/api-contract";
import { assertProperty } from "@stll/property-testing";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  clauses,
  clauseVersions,
  templates,
  templateClauses,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { type ClauseBody, isClauseBody } from "@/api/lib/clauses/types";
import { resolveClauseSlotSources } from "@/api/lib/docx/resolve-clause-slots";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { fillTemplateDocx } from "@/api/lib/templates/template-fill-service";
import { isRecord } from "@/api/lib/type-guards";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { testDocxFile } from "@/api/tests/helpers/scanned-file";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { importHandler } from "./import";
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
    const storedBody = [
      {
        text: "Next text",
        extra: { source: "import" },
        runs: [{ text: "Next text", extra: "run metadata" }],
      },
    ];
    await testDb.insert(clauseVersions).values({
      id: versionId,
      organizationId: ids.orgA,
      clauseId,
      version: 1,
      body: storedBody,
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
            audits.push(...(Array.isArray(event) ? event : [event]));
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
      body: storedBody,
      currentVersion: 2,
      updatedAt: expect.any(Date),
    });
    expect(
      (
        await testDb.query.clauses.findFirst({
          where: { id: { eq: clauseId } },
        })
      )?.body,
    ).toEqual(storedBody);
    const snapshots = await testDb.query.clauseVersions.findMany({
      where: { clauseId: { eq: clauseId } },
    });
    expect(snapshots).toHaveLength(2);
    for (const snapshot of snapshots) {
      expect(snapshot.body).toEqual(storedBody);
    }
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
            set.status = HandlerError.is(result.error)
              ? result.error.status
              : 500;
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
    if (!isRecord(read) || !isClauseBody(read["body"])) {
      throw new Error("Expected a clause body in the HTTP response");
    }
    expect(read["body"]).toEqual([
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
        body: JSON.stringify({
          body: importedBody,
          expectedBody: read["body"],
        }),
      }),
    );
    expect(invalidBodyResponse.status).toBe(422);
    const savedResponse = await app.handle(
      new Request("http://localhost/clause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: nextBody, expectedBody: read["body"] }),
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
        code: CLAUSE_VERSION_LIMIT_ERROR_CODE,
        retryable: false,
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
    expect(result).toMatchObject({
      code: 400,
      response: { code: CLAUSE_VERSION_LIMIT_ERROR_CODE, retryable: false },
    });
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

test("an incomplete working copy persists and reloads while publication refuses it", async () => {
  const clauseId = await seedClause();
  const body: ClauseBody = [{ text: "{% if %}" }];
  const save = async (snapshotVersion: boolean) =>
    await Result.gen(() =>
      updateClauseHandler({
        safeDb,
        organizationId: ids.orgA,
        clauseId,
        body: { body, snapshotVersion },
        recordAuditEvent: async () => undefined,
      }),
    );
  expect(Result.isOk(await save(false))).toBe(true);
  expect(
    (await testDb.query.clauses.findFirst({ where: { id: { eq: clauseId } } }))
      ?.body,
  ).toEqual(body);
  const published = await save(true);
  expect(Result.isError(published)).toBe(true);
  if (Result.isError(published)) {
    expect(published.error).toMatchObject({
      code: "clause_directives_invalid",
      status: 422,
    });
  }
  expect(
    await testDb.$count(clauseVersions, eq(clauseVersions.clauseId, clauseId)),
  ).toBe(0);
});

test("snapshot without a supplied body preserves an invalid working copy without publishing it", async () => {
  const body: ClauseBody = [{ text: "{% if enabled %}" }];
  const clauseId = await seedClause(body);
  const result = await Result.gen(() =>
    updateClauseHandler({
      safeDb,
      organizationId: ids.orgA,
      clauseId,
      body: { snapshotVersion: true },
      recordAuditEvent: async () => undefined,
    }),
  );
  expect(Result.isOk(result)).toBe(true);
  expect(
    (await testDb.query.clauses.findFirst({ where: { id: { eq: clauseId } } }))
      ?.body,
  ).toEqual(body);
  expect(
    await testDb.$count(clauseVersions, eq(clauseVersions.clauseId, clauseId)),
  ).toBe(0);
});

test("historical legacy content restores with a typed warning and retains the exact stored body", async () => {
  const clauseId = await seedClause();
  const versionId = createSafeId<"clauseVersion">();
  const body: ClauseBody = [
    { text: '{{ num("section") }}' },
    { text: "{% if enabled %}" },
  ];
  await testDb.insert(clauseVersions).values({
    id: versionId,
    clauseId,
    organizationId: ids.orgA,
    version: 1,
    body,
  });
  const result = await restoreClauseVersion.handler(
    createTestHandlerContext<
      Parameters<typeof restoreClauseVersion.handler>[0]
    >({
      safeDb,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      params: { clauseId, versionId },
      body: { expectedBody: initialBody },
      recordAuditEvent: async () => undefined,
    }),
  );
  expect(result).toMatchObject({
    body,
    currentVersion: 2,
    clauseWarnings: [
      {
        code: "CLAUSE_LEGACY_DIRECTIVES",
        clauseName: "Clause precondition",
        version: 1,
      },
    ],
  });
  expect(
    (await testDb.query.clauses.findFirst({ where: { id: { eq: clauseId } } }))
      ?.body,
  ).toEqual(body);
});

test("JSON imports inspect every legacy clause and variant without refusing the stored content", async () => {
  const titles = [
    "Imported valid",
    "Imported legacy second",
    "Imported variant third",
  ] as const;
  const malformed: ClauseBody = [{ text: "{% if enabled %}" }];
  const result = await Result.gen(() =>
    importHandler({
      safeDb,
      organizationId: ids.orgA,
      userId: ids.userA1,
      body: {
        file: new File(
          [
            JSON.stringify({
              version: 1,
              exportedAt: "2026-10-03",
              clauses: [
                { title: titles.at(0), body: initialBody },
                { title: titles.at(1), body: malformed },
                {
                  title: titles.at(2),
                  body: initialBody,
                  variants: [{ label: "Legacy", body: malformed }],
                },
              ],
            }),
          ],
          "clauses.json",
        ),
      },
      recordAuditEvent: async () => undefined,
    }),
  );
  expect(Result.isOk(result)).toBe(true);
  if (Result.isOk(result)) {
    expect(result.value).toMatchObject({
      created: 3,
      clauseWarnings: [
        {
          code: "CLAUSE_LEGACY_DIRECTIVES",
          clauseName: titles.at(1),
          version: 1,
        },
        {
          code: "CLAUSE_LEGACY_DIRECTIVES",
          clauseName: `${titles[2]} (Legacy)`,
          version: null,
        },
      ],
    });
  }
  const imported = await testDb.query.clauses.findMany({
    where: { organizationId: { eq: ids.orgA }, title: { in: [...titles] } },
    limit: 3,
  });
  clauseIds.push(...imported.map(({ id }) => id));
  expect(imported).toHaveLength(3);
  expect(imported.find(({ title }) => title === titles.at(1))?.body).toEqual(
    malformed,
  );
});

test("stored legacy versions fill literal markers with warnings and remain tenant scoped", async () => {
  const legacyBodies: ClauseBody[] = [
    [{ text: '{{ num("section") }}' }],
    [{ text: '{{ ref("section") }}' }],
    [{ text: '{{ clause("Nested") }}' }],
    [{ text: "{{ name | ai(adapt=true) }}" }],
    [{ text: "{% if enabled %}" }, { text: "Legacy" }],
  ];
  for (const body of legacyBodies) {
    const clauseId = await seedClause(body);
    const versionId = createSafeId<"clauseVersion">();
    await testDb.insert(clauseVersions).values({
      id: versionId,
      clauseId,
      organizationId: ids.orgA,
      version: 1,
      body,
    });
    const templateId = createSafeId<"template">();
    await testDb.insert(templates).values({
      id: templateId,
      organizationId: ids.orgA,
      name: "Legacy template",
      fileName: "legacy.docx",
      s3Key: "legacy.docx",
      sizeBytes: 1,
      createdBy: ids.userA1,
    });
    await testDb.insert(templateClauses).values({
      id: createSafeId<"templateClause">(),
      organizationId: ids.orgA,
      templateId,
      clauseId,
      clauseVersionId: versionId,
      slotName: "Terms",
    });
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{ clause("Terms") }}</w:t></w:r></w:p></w:body></w:document>',
    );
    const file = testDocxFile(await zip.generateAsync({ type: "uint8array" }));
    const scopedDb = asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    );
    const result = await fillTemplateDocx({
      source: {
        name: "Legacy template",
        fileName: "legacy.docx",
        file,
        templateId,
      },
      scopedDb,
      organizationId: ids.orgA,
      thirdPartyOutboundPermit: undefined,
      values: {},
      requiredFields: "enforce",
      useRecording: "caller",
    });
    expect(result).toHaveProperty("file");
    if (!("file" in result)) {
      throw new TypeError("Expected literal legacy fill");
    }
    expect(result.clauseWarnings).toMatchObject([
      {
        code: "CLAUSE_LEGACY_DIRECTIVES",
        clauseName: "Clause precondition",
        version: 1,
        clauseId,
      },
    ]);
    const output = await JSZip.loadAsync(result.file.bytes);
    const xml = await output.file("word/document.xml")?.async("string");
    for (const paragraph of body) {
      expect(xml).toContain(paragraph.text);
    }
    const slots = [{ name: "Terms", patchKey: "@clause:Terms" }];
    const otherOrg = asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsB1], ids.orgB, ids.userB1),
    );
    expect(
      (await resolveClauseSlotSources(templateId, slots, otherOrg, ids.orgB))
        .size,
    ).toBe(0);
    await testDb.delete(templates).where(eq(templates.id, templateId));
  }
});

test("clause resolution scopes relation reads even without the RLS backstop", async () => {
  const clauseId = createSafeId<"clause">();
  clauseIds.push(clauseId);
  await testDb.insert(clauses).values({
    id: clauseId,
    organizationId: ids.orgB,
    title: "Foreign clause",
    body: initialBody,
    createdBy: ids.userB1,
  });
  const versionId = createSafeId<"clauseVersion">();
  await testDb.insert(clauseVersions).values({
    id: versionId,
    clauseId,
    organizationId: ids.orgB,
    version: 1,
    body: initialBody,
  });
  const templateId = createSafeId<"template">();
  await testDb.insert(templates).values({
    id: templateId,
    organizationId: ids.orgA,
    name: "Scoped template",
    fileName: "scoped.docx",
    s3Key: "scoped.docx",
    sizeBytes: 1,
    createdBy: ids.userA1,
  });
  await testDb.insert(templateClauses).values({
    id: createSafeId<"templateClause">(),
    organizationId: ids.orgA,
    templateId,
    clauseId,
    clauseVersionId: versionId,
    slotName: "Terms",
  });
  const readRows: unknown[] = [];
  const observedDb = {
    query: {
      ...testDb.query,
      templateClauses: {
        findMany: async (
          options: Parameters<typeof testDb.query.templateClauses.findMany>[0],
        ) => {
          const rows = await testDb.query.templateClauses.findMany(options);
          readRows.push(...rows);
          return rows;
        },
      },
    },
    select: testDb.select.bind(testDb),
  };
  const unrestricted = asTestRaw<ScopedDb>(
    async <T>(fn: (tx: typeof observedDb) => Promise<T>) =>
      await fn(observedDb),
  );
  const resolved = await resolveClauseSlotSources(
    templateId,
    [{ name: "Terms", patchKey: "@clause:Terms" }],
    unrestricted,
    ids.orgA,
  );
  expect(resolved.size).toBe(0);
  expect(readRows).toHaveLength(1);
  expect(readRows.at(0)).toMatchObject({ clauseId, clause: null });
  await testDb.delete(templates).where(eq(templates.id, templateId));
});

test("resolved clause provenance names latest, pinned and explicit saved versions", async () => {
  const clauseId = await seedClause();
  const versionId = createSafeId<"clauseVersion">();
  await testDb
    .update(clauses)
    .set({ currentVersion: 2 })
    .where(eq(clauses.id, clauseId));
  await testDb.insert(clauseVersions).values([
    {
      id: versionId,
      clauseId,
      organizationId: ids.orgA,
      version: 1,
      body: initialBody,
    },
    {
      id: createSafeId<"clauseVersion">(),
      clauseId,
      organizationId: ids.orgA,
      version: 2,
      body: nextBody,
    },
  ]);
  const templateId = createSafeId<"template">();
  await testDb.insert(templates).values({
    id: templateId,
    organizationId: ids.orgA,
    name: "Versioned",
    fileName: "versioned.docx",
    s3Key: "versioned.docx",
    sizeBytes: 1,
    createdBy: ids.userA1,
  });
  await testDb.insert(templateClauses).values({
    id: createSafeId<"templateClause">(),
    organizationId: ids.orgA,
    templateId,
    clauseId,
    clauseVersionId: versionId,
    slotName: "Terms",
  });
  const scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  );
  const sources = await resolveClauseSlotSources(
    templateId,
    [
      { name: "Terms", patchKey: "@clause:Terms" },
      {
        name: "Terms",
        patchKey: "@clause:Terms:latest",
        versionModifier: "latest",
      },
      { name: "Terms", patchKey: "@clause:Terms:v1", versionModifier: "v1" },
    ],
    scopedDb,
    ids.orgA,
  );
  expect(sources.get("@clause:Terms")).toMatchObject({
    body: initialBody,
    clause: { resolution: "pinned", version: 1 },
  });
  expect(sources.get("@clause:Terms:latest")).toMatchObject({
    body: nextBody,
    clause: { resolution: "latest", version: 2 },
  });
  expect(sources.get("@clause:Terms:v1")).toMatchObject({
    body: initialBody,
    clause: { resolution: "explicit", version: 1 },
  });
  await testDb.delete(templates).where(eq(templates.id, templateId));
});
