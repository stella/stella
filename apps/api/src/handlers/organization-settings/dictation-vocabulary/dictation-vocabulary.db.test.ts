import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import "@/api/tests/setup-env";

import {
  dictationTermKey,
  MAX_ORGANIZATION_DICTATION_TERMS,
} from "@stll/api-contract/dictation-vocabulary";

import type { SafeDb } from "@/api/db/safe-db";
import { dictationVocabularyTerms } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import addDictationVocabulary from "@/api/handlers/organization-settings/dictation-vocabulary/add";
import checkDictationVocabulary from "@/api/handlers/organization-settings/dictation-vocabulary/check";
import deleteDictationVocabulary from "@/api/handlers/organization-settings/dictation-vocabulary/delete";
import exportDictationVocabulary from "@/api/handlers/organization-settings/dictation-vocabulary/export";
import listDictationVocabulary from "@/api/handlers/organization-settings/dictation-vocabulary/list";
import { HttpStatusResponse } from "@/api/http/status";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  forgetOrganizationVocabularyIndexes,
  readCleanupVocabulary,
  readTranscriptionVocabulary,
} from "@/api/lib/dictation/organization-vocabulary";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;

const safeDbFor = (organizationId: SafeId<"organization">): SafeDb =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [], organizationId, ids.userA1));

// timeout: booting the full PGlite schema can exceed the default hook budget.
beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
}, 60_000);

afterAll(releaseTestDb);

beforeEach(async () => {
  await testDb.delete(dictationVocabularyTerms);
  forgetOrganizationVocabularyIndexes();
});

const base = (organizationId: SafeId<"organization">) => ({
  audit: createBackgroundAuditRecorder({
    organizationId,
    userId: ids.userA1,
    workspaceId: null,
    execution: {
      performer: { type: "user", id: ids.userA1 },
      trigger: { type: "system", source: "dictation_vocabulary_test" },
    },
  }),
  scopedDb: NO_DB,
  safeDb: safeDbFor(organizationId),
  session: { activeOrganizationId: organizationId },
  user: { id: ids.userA1 },
});

/** A handler's answer, or the status it refused with. */
const answered = <T>(result: T | HttpStatusResponse): T => {
  if (result instanceof HttpStatusResponse) {
    throw new TypeError(
      `Expected an answer, got ${result.code} ${JSON.stringify(result.response)}`,
    );
  }
  return result;
};

const add = async (
  terms: string[],
  organizationId: SafeId<"organization"> = ids.orgA,
) =>
  await addDictationVocabulary.handler(
    createTestHandlerContext<
      Parameters<typeof addDictationVocabulary.handler>[0]
    >({
      ...base(organizationId),
      body: v.parse(addDictationVocabulary.config.body, { terms }),
    }),
  );

const check = async (terms: string[]) =>
  await checkDictationVocabulary.handler(
    createTestHandlerContext<
      Parameters<typeof checkDictationVocabulary.handler>[0]
    >({
      ...base(ids.orgA),
      body: v.parse(checkDictationVocabulary.config.body, { terms }),
    }),
  );

const remove = async (termIds: SafeId<"dictationVocabularyTerm">[]) =>
  await deleteDictationVocabulary.handler(
    createTestHandlerContext<
      Parameters<typeof deleteDictationVocabulary.handler>[0]
    >({ ...base(ids.orgA), body: { ids: termIds } }),
  );

const exported = async (organizationId: SafeId<"organization">) =>
  await exportDictationVocabulary.handler(
    createTestHandlerContext<
      Parameters<typeof exportDictationVocabulary.handler>[0]
    >(base(organizationId)),
  );

const list = async (query: Record<string, string> = {}) =>
  answered(
    await listDictationVocabulary.handler(
      createTestHandlerContext<
        Parameters<typeof listDictationVocabulary.handler>[0]
      >({
        ...base(ids.orgA),
        query: v.parse(listDictationVocabulary.config.query, query),
      }),
    ),
  );

describe("who manages the organization's dictation words", () => {
  test("owners and administrators only", () => {
    for (const { config } of [
      listDictationVocabulary,
      addDictationVocabulary,
      checkDictationVocabulary,
      deleteDictationVocabulary,
      exportDictationVocabulary,
    ]) {
      for (const role of ["owner", "admin"] as const) {
        expect(
          hasMemberPermission(sessionMemberRole(role), config.permissions),
        ).toBe(true);
      }
      for (const role of ["member", "intern", "external"] as const) {
        expect(
          hasMemberPermission(sessionMemberRole(role), config.permissions),
        ).toBe(false);
      }
    }
  });
});

describe("the organization's dictation words", () => {
  test("a word is listed once whatever its case, and an add says what it skipped", async () => {
    expect(await add(["Novák", "Deloitte"])).toEqual({
      added: 2,
      skipped: 0,
      total: 2,
    });
    expect(await add(["NOVÁK", "Novak", "KPMG"])).toEqual({
      added: 2,
      skipped: 1,
      total: 4,
    });
    expect(await check(["novák", "Baker McKenzie"])).toEqual({
      listed: 1,
      total: 4,
    });
    // One request may not name a word twice.
    expect(
      v.is(addDictationVocabulary.config.body, { terms: ["KPMG", "kpmg"] }),
    ).toBe(false);
    // Words arrive as stored: trimmed and single-spaced.
    expect(v.is(addDictationVocabulary.config.body, { terms: [" KPMG"] })).toBe(
      false,
    );
  });

  test("the list never holds more than its limit", async () => {
    await testDb.insert(dictationVocabularyTerms).values(
      Array.from(
        { length: MAX_ORGANIZATION_DICTATION_TERMS - 1 },
        (_, index) => ({
          organizationId: ids.orgA,
          term: `word ${index}`,
          termKey: `word ${index}`,
        }),
      ),
    );
    const refused = await add(["one", "two"]);
    expect(
      refused instanceof HttpStatusResponse
        ? { status: refused.code, body: JSON.stringify(refused.response) }
        : refused,
    ).toMatchObject({
      status: 409,
      body: expect.stringContaining("dictation_vocabulary_full"),
    });
    // A word already listed adds nothing, so it still fits.
    expect(await add(["word 1", "one"])).toEqual({
      added: 1,
      skipped: 1,
      total: MAX_ORGANIZATION_DICTATION_TERMS,
    });
  });

  test("lists alphabetically a page at a time, and searches without case", async () => {
    await add(["Žofie", "alfa", "Beta", "gama", "Alfons"]);
    const first = await list({ limit: "2" });
    expect(first.items.map(({ term }) => term)).toEqual(["alfa", "Alfons"]);
    expect(first).toMatchObject({ total: 5, matching: 5, max: 10_000 });
    const second = await list({ limit: "2", cursor: first.nextCursor ?? "" });
    expect(second.items.map(({ term }) => term)).toEqual(["Beta", "gama"]);
    const third = await list({ limit: "2", cursor: second.nextCursor ?? "" });
    expect(third.items.map(({ term }) => term)).toEqual(["Žofie"]);
    expect(third.nextCursor).toBeNull();

    const found = await list({ search: "ALF" });
    expect(found.items.map(({ term }) => term)).toEqual(["alfa", "Alfons"]);
    expect(found).toMatchObject({ total: 5, matching: 2 });
    // LIKE's wildcards are literal.
    expect((await list({ search: "%" })).matching).toBe(0);
  });

  test("deletes only the organization's own words, and exports the rest", async () => {
    await add(["Novák", "Deloitte"]);
    await add(["Foreign"], ids.orgB);
    const listed = await list();
    const novak = listed.items.find(({ term }) => term === "Novák");
    const foreign = (
      await testDb
        .select({ id: dictationVocabularyTerms.id })
        .from(dictationVocabularyTerms)
        .where(eq(dictationVocabularyTerms.organizationId, ids.orgB))
    ).at(0);
    if (novak === undefined || foreign === undefined) {
      throw new TypeError("Expected both words");
    }
    expect(await remove([novak.id, foreign.id])).toEqual({
      deleted: 1,
      total: 1,
    });
    expect(await exported(ids.orgA)).toEqual({ terms: ["Deloitte"] });
    expect(await exported(ids.orgB)).toEqual({ terms: ["Foreign"] });
  });
});

describe("what a dictation reads of them", () => {
  test("cleanup gets the speaker's words, then the words the transcript mentions, after every change", async () => {
    const read = async () =>
      (
        await readCleanupVocabulary({
          safeDb: safeDbFor(ids.orgA),
          organizationId: ids.orgA,
          transcript: "Majkrosoft a Novák",
          personal: ["Novák"],
        })
      ).unwrap();
    expect(await read()).toEqual(["Novák"]);
    await add(["Microsoft", "novák", "Deloitte"]);
    expect(await read()).toEqual(["Novák", "Microsoft"]);
    const microsoft = (await list({ search: "micro" })).items.at(0);
    if (microsoft === undefined) {
      throw new TypeError("Expected the word");
    }
    await remove([microsoft.id]);
    expect(await read()).toEqual(["Novák"]);
  });

  test("transcription gets the request's words, then the newest, within the limit", async () => {
    await add(["older"]);
    await add(["newer", "Request word"]);
    const words = (
      await readTranscriptionVocabulary({
        safeDb: safeDbFor(ids.orgA),
        organizationId: ids.orgA,
        first: ["request word", "Matter name"],
      })
    ).unwrap();
    expect(words.slice(0, 2)).toEqual(["request word", "Matter name"]);
    expect(new Set(words.slice(2))).toEqual(new Set(["newer", "older"]));
    expect(new Set(words.map(dictationTermKey)).size).toBe(words.length);
  });
});
