// The STELLA_RUN_POSTGRES_TESTS runner also executes this verification suite.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";

import { VERIFICATION_SCOPE_REFUSALS } from "@stll/api-contract/verification-scope";
import { createTestState } from "@stll/test-state";

import { user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { legalLists, legalListVerificationRuns } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import statementPath from "@/api/handlers/lists/sample-case/whitfield-witness-statement.docx" with { type: "file" };
import { HttpStatusResponse } from "@/api/http/status";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { AI_CONFIG_UNREADABLE_ERROR_CODE } from "@/api/lib/ai-config-response";
import { createSafeId } from "@/api/lib/branded-types";
import { createFileKey } from "@/api/lib/file-key";
import { readVerificationDocument } from "@/api/lib/lists/verification/document-text";
import {
  resolveParagraphScope,
  scopePassages,
} from "@/api/lib/lists/verification/paragraph-scope";
import { readVerificationRun } from "@/api/lib/lists/verification/read-run";
import { listRunSummaries } from "@/api/lib/lists/verification/run-summary";
import { startVerificationRun } from "@/api/lib/lists/verification/start-run";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import createVerification from "./create";

setDefaultTimeout(120_000);
const state = createTestState({ file: import.meta.path, config: env });
let testDb: TestDatabase;
let ids: TestIds;
state.beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  await testDb
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, ids.userA1));
});
afterAll(async () => await releaseRlsFixture());

describe("verification creation requires complete AI admission", () => {
  test.each([
    {
      status: ORG_AI_CONFIG_STATUS.ownKeyRequired,
      expectedStatus: 403,
      expectedCode: undefined,
    },
    {
      status: ORG_AI_CONFIG_STATUS.unreadable,
      expectedStatus: 503,
      expectedCode: AI_CONFIG_UNREADABLE_ERROR_CODE,
    },
    {
      status: ORG_AI_CONFIG_STATUS.memberAssignmentRequired,
      expectedStatus: 403,
      expectedCode: "ai_member_assignment_required",
    },
  ])(
    "returns the typed $status error before document lookup",
    async ({ status, expectedStatus, expectedCode }) => {
      const previous = env.API_FEATURE_ACCESS_GRANTS;
      const previousDeployment = env.FEATURE_LEGAL_LISTS;
      env.FEATURE_LEGAL_LISTS = true;
      env.API_FEATURE_ACCESS_GRANTS = {
        "legal-lists": [{ type: "organization", organizationId: ids.orgA }],
        "list-verification": [
          { type: "organization", organizationId: ids.orgA },
        ],
      };
      const scoped = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
      let transactions = 0;
      const safeDb: typeof scoped = async (operation) => {
        transactions++;
        return await scoped(operation);
      };
      try {
        const result = await createVerification.handler(
          createTestHandlerContext<
            Parameters<typeof createVerification.handler>[0]
          >({
            audit: NO_AUDIT,
            scopedDb: NO_DB,
            workspaceId: ids.wsA1,
            session: { activeOrganizationId: ids.orgA },
            user: { id: ids.userA1 },
            safeDb,
            orgAIConfig: null,
            orgAIConfigStatus: status,
            body: {
              listId: createSafeId<"legalList">(),
              entityId: ids.entityA1,
              fileFieldId: ids.fileFieldA1,
            },
          }),
        );
        expect(result).toBeInstanceOf(HttpStatusResponse);
        if (result instanceof HttpStatusResponse) {
          expect(result.code).toBe(expectedStatus);
          if (expectedCode !== undefined) {
            expect(result.response).toHaveProperty("code", expectedCode);
          }
        }
        // Identity and resource preflight settle before document, run or queue work.
        expect(transactions).toBe(2);
      } finally {
        env.API_FEATURE_ACCESS_GRANTS = previous;
        env.FEATURE_LEGAL_LISTS = previousDeployment;
      }
    },
  );
});

describe("a verification limited to a paragraph range", () => {
  // A numbered witness statement (paragraphs 1 to 13) stands in for the
  // fixture document's DOCX.
  let fakeS3: FakeS3;
  const listId = createSafeId<"legalList">();
  const scopedDb = () => createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);

  state.beforeAll(async () => {
    fakeS3 = startFakeS3();
    fakeS3.put(
      envBase.S3_BUCKET,
      createFileKey({
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        fileId: ids.fileObjectA1,
        mimeType: DOCX_MIME_TYPE,
      }),
      new Uint8Array(await Bun.file(statementPath).arrayBuffer()),
      DOCX_MIME_TYPE,
    );
    await testDb.insert(legalLists).values({
      id: listId,
      workspaceId: ids.wsA1,
      name: "Range fixture facts",
      createdBy: ids.userA1,
    });
  });
  afterAll(async () => {
    fakeS3.stop();
    await testDb
      .delete(legalListVerificationRuns)
      .where(eq(legalListVerificationRuns.entityId, ids.entityA1));
    await testDb.delete(legalLists).where(eq(legalLists.id, listId));
  });

  const startRange = async (paragraphs: { from: number; to: number }) => {
    state.setConfig("FEATURE_LEGAL_LISTS", true);
    state.setConfig("API_FEATURE_ACCESS_GRANTS", {
      "legal-lists": [{ type: "organization", organizationId: ids.orgA }],
      "list-verification": [{ type: "organization", organizationId: ids.orgA }],
    });
    return await createVerification.handler(
      createTestHandlerContext<
        Parameters<typeof createVerification.handler>[0]
      >({
        audit: NO_AUDIT,
        scopedDb: NO_DB,
        workspaceId: ids.wsA1,
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        safeDb: scopedDb(),
        orgAIConfig: null,
        orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
        body: {
          listId,
          entityId: ids.entityA1,
          fileFieldId: ids.fileFieldA1,
          paragraphs,
        },
      }),
    );
  };

  const runsOfDocument = async () =>
    await testDb
      .select({ id: legalListVerificationRuns.id })
      .from(legalListVerificationRuns)
      .where(eq(legalListVerificationRuns.entityId, ids.entityA1));

  test("a range the statement does not have is refused before any run starts", async () => {
    const result = await startRange({ from: 12, to: 20 });
    expect(result).toBeInstanceOf(HttpStatusResponse);
    if (result instanceof HttpStatusResponse) {
      expect(result.code).toBe(422);
      expect(result.response).toMatchObject({
        code: VERIFICATION_SCOPE_REFUSALS.paragraphsNotFound,
        message: "Paragraph 20 is not in this document.",
        hint: "Its paragraphs run from 1 to 13. Use the numbers the document prints.",
      });
    }
    // Never widened to the whole document: nothing was started.
    expect(await runsOfDocument()).toEqual([]);
  });

  test("a resolved range is stored on the run and read back with it", async () => {
    const document = await readVerificationDocument({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      file: {
        fileId: ids.fileObjectA1,
        mimeType: DOCX_MIME_TYPE,
        pdfFileId: null,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (document.type !== "read") {
      throw new Error(`Expected the statement to read, got ${document.type}`);
    }
    const resolution = resolveParagraphScope(document.blocks, {
      from: 4,
      to: 6,
    });
    if (resolution.type !== "resolved") {
      throw new Error(`Expected the range to resolve, got ${resolution.type}`);
    }
    const { scope } = resolution;
    expect(scope).toMatchObject({ numbering: "document", from: 4, to: 6 });
    const read = scopePassages(document.blocks, scope) ?? [];
    expect(
      read.map(({ block, start, end }) => block.text.slice(start, end).trim()),
    ).toEqual([
      expect.stringMatching(/^4\. On the question of the August payment/u),
      expect.stringMatching(/^5\. I never discussed the matter/u),
      expect.stringMatching(/^6\. I was on annual leave/u),
    ]);

    const runId = createSafeId<"legalListVerificationRun">();
    const started = await startVerificationRun({
      safeDb: asTestRaw<SafeDb>(scopedDb()),
      recordAuditEvent: async () => {},
      run: {
        id: runId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        entityId: ids.entityA1,
        fileFieldId: ids.fileFieldA1,
        entityVersionId: ids.entityVersionA1,
        contentSha256: "a".repeat(64),
        evidence: { listId, facts: [] },
        scope,
        requestedBy: ids.userA1,
      },
    });
    expect(started.isOk() && started.value).toBe(true);
    const stored = await scopedDb()(
      async (tx) =>
        await readVerificationRun({ tx, workspaceId: ids.wsA1, runId }),
    );
    expect(stored.isOk() ? stored.value?.scope : null).toEqual(scope);
    const summaries = await listRunSummaries({
      safeDb: asTestRaw<SafeDb>(scopedDb()),
      workspaceId: ids.wsA1,
      entityId: ids.entityA1,
      fileFieldId: ids.fileFieldA1,
      cursor: undefined,
      limit: 5,
    });
    expect(
      summaries.isOk()
        ? summaries.value.items.find((run) => run.id === runId)?.scope
        : null,
    ).toEqual(scope);
    await testDb
      .update(legalListVerificationRuns)
      .set({
        status: "failed",
        errorCode: "internal",
        finishedAt: new Date("2026-11-11T00:00:00.000Z"),
      })
      .where(eq(legalListVerificationRuns.id, runId));
  });

  test.each([
    { name: "a range starting at 0", patch: { from: 0 } },
    { name: "a reversed range", patch: { from: 9, to: 4 } },
    { name: "an unknown numbering", patch: { numbering: "guessed" } },
    { name: "a range without its numbering", patch: { numbering: undefined } },
    { name: "a null numbering", patch: { numbering: null } },
    { name: "a range without its edges", patch: { start: null } },
  ])("the database refuses $name", async ({ patch }) => {
    const refused = await testDb
      .insert(legalListVerificationRuns)
      .values({
        id: createSafeId<"legalListVerificationRun">(),
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        entityId: ids.entityA1,
        fileFieldId: ids.fileFieldA1,
        entityVersionId: ids.entityVersionA1,
        contentSha256: "a".repeat(64),
        evidence: { listId, facts: [] },
        scope: asTestRaw({
          kind: "paragraphs",
          from: 4,
          to: 6,
          numbering: "document",
          start: { blockId: "b", offset: 0 },
          end: { blockId: "c", offset: 0 },
          ...patch,
        }),
        status: "failed",
        errorCode: "internal",
        requestedBy: ids.userA1,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refused).toMatchObject({
      cause: { constraint: "legal_list_verification_runs_scope_check" },
    });
  });
});
