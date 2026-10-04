import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { templates } from "@/api/db/schema";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { templateDecideConditionsLogic } from "./template-decide-conditions";

let testDb: TestDatabase;
let ids: TestIds;
let scopedDb: ScopedDb;

beforeAll(async () => {
  ({ testDb, ids } = await getRlsFixture());
  // Exercise query-level scope independently of the separate RLS backstop.
  scopedDb = asTestRaw<ScopedDb>(
    async (callback: (tx: TestDatabase) => Promise<unknown>) =>
      await callback(testDb),
  );
  await testDb
    .update(templates)
    .set({ manifest: { version: 1, fields: [], clauseSlots: [] } })
    .where(eq(templates.id, ids.templateB));
}, 120_000);

afterAll(async () => await releaseRlsFixture());

test("condition preview addresses a template only in its organization", async () => {
  const own = await templateDecideConditionsLogic({
    scopedDb,
    organizationId: ids.orgB,
    templateId: ids.templateB,
    body: { values: {} },
    orgAIConfig: null,
    client: null,
    abortSignal: new AbortController().signal,
  });
  expect(own.unwrap()).toEqual({ conditions: [], model: null });
  const other = await templateDecideConditionsLogic({
    scopedDb,
    organizationId: ids.orgA,
    templateId: ids.templateB,
    body: { values: {} },
    orgAIConfig: null,
    client: null,
    abortSignal: new AbortController().signal,
  });
  expect(Result.isError(other)).toBe(true);
  if (Result.isError(other)) {
    expect(other.error.status).toBe(404);
  }
});
