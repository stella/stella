import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawSources,
  legislationDocuments,
  legislationIndexJobs,
  legislationSources,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { recordCorpusWithdrawalAuditEvent } from "@/api/lib/legal-search/corpus-index-job-audit";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-000000000201",
);
const DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000202",
);
const LEGISLATION_SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000203",
);
const LEGISLATION_DOCUMENT_ID = toSafeId<"legislationDocument">(
  "0198e331-e578-7000-8000-000000000204",
);
const GENERATION = "case_law_v5";

// The driver reports a constraint violation as the cause of the failed query,
// so the assertion reads the whole chain.
const errorMessageChain = (error: unknown): string => {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" | ");
};

const rejectionMessage = async (run: Promise<unknown>): Promise<string> =>
  await run.then(
    () => "no rejection",
    (error: unknown) => errorMessageChain(error),
  );

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
});

beforeEach(async () => {
  await db.delete(caseLawIndexJobs).where(sql`true`);
  await db.delete(legislationIndexJobs).where(sql`true`);
  await db.delete(caseLawDecisions).where(sql`true`);
  await db.delete(legislationDocuments).where(sql`true`);
  await db.delete(caseLawSources).where(sql`true`);
  await db.delete(legislationSources).where(sql`true`);

  await db.insert(caseLawSources).values({
    id: SOURCE_ID,
    adapterKey: "corpus-index-job-audit",
    name: "Corpus index job audit",
  });
  await db.insert(caseLawDecisions).values({
    id: DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "4 As 3/2008",
    court: "Nejvyšší správní soud",
    country: "CZE",
    language: "cs",
  });
  await db.insert(legislationSources).values({
    id: LEGISLATION_SOURCE_ID,
    adapterKey: "corpus-index-job-audit",
    name: "Corpus index job audit",
  });
  await db.insert(legislationDocuments).values({
    id: LEGISLATION_DOCUMENT_ID,
    sourceId: LEGISLATION_SOURCE_ID,
    eli: "eli/cz/sb/2012/89",
    title: "Občanský zákoník",
    country: "CZE",
    language: "cs",
  });
});

afterAll(async () => {
  await client.close();
});

test("a withdrawal files its reason as detail, not as a failure", async () => {
  await db.transaction(
    async (tx) =>
      await recordCorpusWithdrawalAuditEvent(asTestRaw<Transaction>(tx), {
        decisionId: DECISION_ID,
        generation: GENERATION,
        reason: "the stored payload re-parses to no document",
      }),
  );

  const [audited] = await db
    .select({
      operation: caseLawIndexJobs.operation,
      status: caseLawIndexJobs.status,
      detail: caseLawIndexJobs.detail,
      errorMessage: caseLawIndexJobs.errorMessage,
    })
    .from(caseLawIndexJobs)
    .where(eq(caseLawIndexJobs.decisionId, DECISION_ID));
  expect(audited).toEqual({
    operation: "withdraw",
    status: "succeeded",
    detail: "the stored payload re-parses to no document",
    errorMessage: null,
  });
});

test("the database refuses a succeeded row that carries a failure", async () => {
  expect(
    await rejectionMessage(
      db.insert(caseLawIndexJobs).values({
        decisionId: DECISION_ID,
        generation: GENERATION,
        operation: "withdraw",
        status: "succeeded",
        errorMessage: "a reason filed where a failure belongs",
      }),
    ),
  ).toContain(
    'violates check constraint "case_law_index_jobs_succeeded_error_message"',
  );

  // A failed row is what the column is for, and it still records why.
  await db.insert(caseLawIndexJobs).values({
    decisionId: DECISION_ID,
    generation: GENERATION,
    operation: "index",
    status: "failed",
    errorMessage: "the index write did not land",
  });
  expect(
    await db
      .select({ errorMessage: caseLawIndexJobs.errorMessage })
      .from(caseLawIndexJobs),
  ).toEqual([{ errorMessage: "the index write did not land" }]);
});

test("legislation carries the same invariant", async () => {
  expect(
    await rejectionMessage(
      db.insert(legislationIndexJobs).values({
        documentId: LEGISLATION_DOCUMENT_ID,
        generation: "legislation_v2",
        operation: "withdraw",
        status: "succeeded",
        errorMessage: "a reason filed where a failure belongs",
      }),
    ),
  ).toContain(
    'violates check constraint "legislation_index_jobs_succeeded_error_message"',
  );

  await db.insert(legislationIndexJobs).values({
    documentId: LEGISLATION_DOCUMENT_ID,
    generation: "legislation_v2",
    operation: "withdraw",
    status: "succeeded",
    detail: "the stored payload re-parses to no document",
  });
  expect(
    await db
      .select({
        detail: legislationIndexJobs.detail,
        errorMessage: legislationIndexJobs.errorMessage,
      })
      .from(legislationIndexJobs),
  ).toEqual([
    {
      detail: "the stored payload re-parses to no document",
      errorMessage: null,
    },
  ]);
});
