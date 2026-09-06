import { Result, UnhandledException } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  bufferObjectCleanupIntents,
  templateDeletionCleanupRequests,
  templates,
  templateVersions,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { arrayOrEmpty } from "@/api/lib/array";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { reconcileBufferObjectCleanupIntents } from "@/api/lib/buffer-intent-reconciliation";
import type { TemplateManifest } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { S3_OBJECT_WRITE_CERTAINTY } from "@/api/lib/s3";
import { buildTemplateS3Key } from "@/api/lib/templates/storage-keys";
import { writeStoredTemplate } from "@/api/lib/templates/write-template";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let recordAuditEvent: AuditRecorder;

beforeAll(async () => {
  ({ testDb, ids } = await getRlsFixture());
  safeDb = asTestRaw<SafeDb>(createSafeDb(testDb, [], ids.orgA, ids.userA1));
  recordAuditEvent = createAuditRecorder({
    organizationId: ids.orgA,
    workspaceId: null,
    userId: ids.userA1,
    request: new Request("https://example.test/templates"),
    server: null,
  });
}, 120_000);

afterAll(async () => await releaseRlsFixture());

const fixture = async () => {
  const templateId = createSafeId<"template">();
  const s3Key = buildTemplateS3Key(ids.orgA, templateId);
  const manifest: TemplateManifest = {
    version: 1,
    fields: [{ path: "initial" }],
  };
  const objects = new Map<string, Uint8Array>([
    [s3Key, new TextEncoder().encode(JSON.stringify(manifest))],
  ]);
  await testDb.insert(templates).values({
    id: templateId,
    organizationId: ids.orgA,
    name: "Writer test",
    fileName: "template.docx",
    s3Key,
    sizeBytes: 1,
    fieldCount: 1,
    manifest,
    createdBy: ids.userA1,
  });
  await testDb.insert(templateVersions).values({
    id: createSafeId<"templateVersion">(),
    organizationId: ids.orgA,
    templateId,
    version: 1,
    s3Key,
    fieldCount: 1,
    manifest,
    createdBy: ids.userA1,
  });
  const options = {
    safeDb,
    organizationId: ids.orgA,
    templateId,
    recordAuditEvent,
  };
  const prepare = async (snapshot: { manifest: TemplateManifest | null }) => {
    const next: TemplateManifest = {
      version: 1,
      fields: [...arrayOrEmpty(snapshot.manifest?.fields), { path: "added" }],
    };
    return Result.ok({
      manifest: next,
      bytes: new TextEncoder().encode(JSON.stringify(next)),
    });
  };
  const writeObject: NonNullable<
    Parameters<typeof writeStoredTemplate>[0]["writeObject"]
  > = async ({ key, data }) => {
    expect(typeof data).not.toBe("string");
    if (typeof data === "string") {
      throw new HandlerError({ status: 500, message: "Expected bytes" });
    }
    expect(objects.has(key)).toBe(false);
    objects.set(key, data);
    return S3_OBJECT_WRITE_CERTAINTY.CONFIRMED;
  };
  const state = async () => ({
    current: await testDb.query.templates.findFirst({
      where: { id: { eq: templateId } },
    }),
    versions: await testDb
      .select()
      .from(templateVersions)
      .where(eq(templateVersions.templateId, templateId))
      .orderBy(templateVersions.version),
    intents: await testDb
      .select()
      .from(bufferObjectCleanupIntents)
      .where(
        sql`${bufferObjectCleanupIntents.objectKey} LIKE ${`${ids.orgA}/templates/${templateId}/%`}`,
      ),
    audits: await testDb
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, templateId)),
  });
  return { options, prepare, writeObject, objects, state, s3Key };
};

const WRITE_MODES = ["new-version", "current-version"] as const;
const modeFor = (type: (typeof WRITE_MODES)[number]) =>
  type === "new-version" ? { type, userId: ids.userA1 } : { type };

test.each(
  WRITE_MODES.flatMap((first) =>
    WRITE_MODES.map((second) => [first, second] as const),
  ),
)(
  "overlapping %s and %s preserve bytes, history, audit, and recovery",
  async (first, second) => {
    const f = await fixture();
    let injected = false;
    const result = await Result.gen(() =>
      writeStoredTemplate({
        ...f.options,
        mode: modeFor(first),
        prepare: f.prepare,
        async writeObject(object) {
          await f.writeObject(object);
          if (!injected) {
            injected = true;
            const winner = await Result.gen(() =>
              writeStoredTemplate({
                ...f.options,
                mode: modeFor(second),
                prepare: f.prepare,
                writeObject: f.writeObject,
              }),
            );
            expect(Result.isOk(winner)).toBe(true);
          }
          return S3_OBJECT_WRITE_CERTAINTY.CONFIRMED;
        },
      }),
    );
    expect(Result.isOk(result)).toBe(true);
    const state = await f.state();
    const expectedVersion =
      1 + Number(first === "new-version") + Number(second === "new-version");
    expect(state.current?.currentVersion).toBe(expectedVersion);
    expect(state.current?.manifest?.fields).toHaveLength(3);
    expect(state.versions.map(({ version }) => version)).toEqual(
      Array.from({ length: expectedVersion }, (_, index) => index + 1),
    );
    expect(state.audits).toHaveLength(2);
    expect(state.intents).toHaveLength(1);
    expect(state.intents.at(0)?.status).toBe("orphaned");
    for (const version of state.versions) {
      const stored = f.objects.get(version.s3Key);
      expect(stored).toBeDefined();
      if (!stored) {
        throw new HandlerError({
          status: 500,
          message: "Published bytes missing",
        });
      }
      const embedded: unknown = JSON.parse(new TextDecoder().decode(stored));
      expect(embedded).toEqual(version.manifest);
      expect(
        state.intents.some(({ objectKey }) => objectKey === version.s3Key),
      ).toBe(false);
    }
    const retired = await testDb
      .select()
      .from(templateDeletionCleanupRequests)
      .where(eq(templateDeletionCleanupRequests.organizationId, ids.orgA));
    expect(retired.some(({ s3Keys }) => s3Keys.includes(f.s3Key))).toBe(
      second === "current-version",
    );
  },
);

test("a lost commit acknowledgement cannot reclaim the committed object's bytes", async () => {
  const f = await fixture();
  const uncertainDb: SafeDb = async (callback, retry) => {
    const result = await safeDb(callback, retry);
    if (
      Result.isOk(result) &&
      typeof result.value === "object" &&
      result.value !== null &&
      "type" in result.value &&
      result.value.type === "published"
    ) {
      return Result.err(
        new UnhandledException({ cause: "Lost commit acknowledgement" }),
      );
    }
    return result;
  };
  const result = await Result.gen(() =>
    writeStoredTemplate({
      ...f.options,
      safeDb: uncertainDb,
      mode: { type: "new-version", userId: ids.userA1 },
      prepare: f.prepare,
      writeObject: f.writeObject,
    }),
  );
  expect(Result.isError(result)).toBe(true);
  const state = await f.state();
  expect(state.current?.currentVersion).toBe(2);
  expect(state.versions).toHaveLength(2);
  expect(state.audits).toHaveLength(1);
  expect(state.intents).toHaveLength(0);
  expect(state.current && f.objects.has(state.current.s3Key)).toBe(true);
});

test("an upload failure keeps its exact key recoverable without publishing", async () => {
  const f = await fixture();
  const result = await Result.gen(() =>
    writeStoredTemplate({
      ...f.options,
      mode: { type: "current-version" },
      prepare: f.prepare,
      async writeObject(object) {
        await f.writeObject(object);
        throw new HandlerError({
          status: 500,
          message: "Injected upload failure",
        });
      },
    }),
  );
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error.cause).toMatchObject({
      message: "Injected upload failure",
    });
  }
  const state = await f.state();
  expect(state.current?.s3Key).toBe(f.s3Key);
  expect(state.intents).toHaveLength(1);
  expect(state.audits).toHaveLength(0);
});

test("failed audit rolls back publication and retains recovery ownership", async () => {
  const f = await fixture();
  const result = await Result.gen(() =>
    writeStoredTemplate({
      ...f.options,
      mode: { type: "new-version", userId: ids.userA1 },
      prepare: f.prepare,
      writeObject: f.writeObject,
      async recordAuditEvent(tx, event) {
        await recordAuditEvent(tx, event);
        throw new HandlerError({
          status: 500,
          message: "Injected audit failure",
        });
      },
    }),
  );
  expect(Result.isError(result)).toBe(true);
  const state = await f.state();
  expect(state.current?.s3Key).toBe(f.s3Key);
  expect(state.versions).toHaveLength(1);
  expect(state.audits).toHaveLength(0);
  expect(state.intents).toHaveLength(1);
  expect(state.intents.at(0)?.status).toBe("writing");
});

test("an upload with an outstanding timed-out PUT remains quarantined instead of publishing", async () => {
  const f = await fixture();
  const result = await Result.gen(() =>
    writeStoredTemplate({
      ...f.options,
      mode: { type: "current-version" },
      prepare: f.prepare,
      async writeObject(object) {
        await f.writeObject(object);
        return S3_OBJECT_WRITE_CERTAINTY.UNCERTAIN;
      },
    }),
  );
  expect(
    Result.isError(result) &&
      HandlerError.is(result.error) &&
      result.error.status,
  ).toBe(503);
  const state = await f.state();
  expect(state.current?.s3Key).toBe(f.s3Key);
  expect(state.versions).toHaveLength(1);
  expect(state.audits).toHaveLength(0);
  expect(state.intents).toHaveLength(1);
  expect(state.intents.at(0)?.status).toBe("writing");
});

test("storage and preparation never run inside a database transaction", async () => {
  const f = await fixture();
  let active = 0;
  const observedDb: SafeDb = async (operation, retry) =>
    await safeDb(async (tx) => {
      active += 1;
      const result = await operation(tx);
      active -= 1;
      return result;
    }, retry);
  const result = await Result.gen(() =>
    writeStoredTemplate({
      ...f.options,
      safeDb: observedDb,
      mode: { type: "new-version", userId: ids.userA1 },
      async prepare(snapshot) {
        expect(active).toBe(0);
        return await f.prepare(snapshot);
      },
      async writeObject(object) {
        expect(active).toBe(0);
        return await f.writeObject(object);
      },
    }),
  );
  expect(Result.isOk(result)).toBe(true);
  expect((await f.state()).intents).toHaveLength(0);
});

test("a reclaimed upload cannot publish after its writer ownership expires", async () => {
  const f = await fixture();
  const rootSafeDb: SafeDb = async (callback) =>
    await Result.tryPromise(
      async () =>
        await testDb.transaction(
          async (tx) => await callback(asTestRaw<Transaction>(tx)),
        ),
    );
  const result = await Result.gen(() =>
    writeStoredTemplate({
      ...f.options,
      mode: { type: "current-version" },
      prepare: f.prepare,
      async writeObject(object) {
        await f.writeObject(object);
        await testDb
          .update(bufferObjectCleanupIntents)
          .set({ nextAttemptAt: new Date(0) })
          .where(eq(bufferObjectCleanupIntents.objectKey, object.key));
        await reconcileBufferObjectCleanupIntents({
          safeDb: rootSafeDb,
          limit: 100,
          async deleteObject(key) {
            f.objects.delete(key);
          },
        });
        return S3_OBJECT_WRITE_CERTAINTY.CONFIRMED;
      },
    }),
  );
  expect(Result.isError(result)).toBe(true);
  const state = await f.state();
  expect(state.current?.s3Key).toBe(f.s3Key);
  expect(state.intents.at(0)?.status).toBe("recovering");
  expect(state.audits).toHaveLength(0);
});

test("cross-tenant writers cannot prepare or upload a hidden template", async () => {
  const f = await fixture();
  const result = await Result.gen(() =>
    writeStoredTemplate({
      ...f.options,
      safeDb: asTestRaw<SafeDb>(createSafeDb(testDb, [], ids.orgB, ids.userB1)),
      organizationId: ids.orgB,
      mode: { type: "current-version" },
      async prepare() {
        throw new HandlerError({
          status: 500,
          message: "Hidden template reached preparation",
        });
      },
      writeObject: f.writeObject,
    }),
  );
  expect(
    Result.isError(result) &&
      HandlerError.is(result.error) &&
      result.error.status,
  ).toBe(404);
  expect(f.objects.size).toBe(1);
});

test("deletion during preparation returns not found without starting an upload", async () => {
  const f = await fixture();
  const result = await Result.gen(() =>
    writeStoredTemplate({
      ...f.options,
      mode: { type: "current-version" },
      writeObject: f.writeObject,
      async prepare(snapshot) {
        await testDb
          .delete(templates)
          .where(eq(templates.id, f.options.templateId));
        return await f.prepare(snapshot);
      },
    }),
  );
  expect(
    Result.isError(result) &&
      HandlerError.is(result.error) &&
      result.error.status,
  ).toBe(404);
  expect(f.objects.size).toBe(1);
  const state = await f.state();
  expect(state.intents).toHaveLength(0);
});

test("the version limit is enforced at publication and leaves the candidate recoverable", async () => {
  const f = await fixture();
  await testDb.insert(templateVersions).values(
    Array.from(
      { length: LIMITS.templateVersionsPerTemplate - 1 },
      (_, index) => ({
        id: createSafeId<"templateVersion">(),
        organizationId: ids.orgA,
        templateId: f.options.templateId,
        version: index + 2,
        s3Key: f.s3Key,
        fieldCount: 1,
        createdBy: ids.userA1,
      }),
    ),
  );
  await testDb
    .update(templates)
    .set({ currentVersion: LIMITS.templateVersionsPerTemplate })
    .where(eq(templates.id, f.options.templateId));
  const result = await Result.gen(() =>
    writeStoredTemplate({
      ...f.options,
      mode: { type: "new-version", userId: ids.userA1 },
      prepare: f.prepare,
      writeObject: f.writeObject,
    }),
  );
  expect(
    Result.isError(result) &&
      HandlerError.is(result.error) &&
      result.error.message,
  ).toBe("Version limit reached for this template");
  const state = await f.state();
  expect(state.versions).toHaveLength(LIMITS.templateVersionsPerTemplate);
  expect(state.current?.s3Key).toBe(f.s3Key);
  expect(state.audits).toHaveLength(0);
  expect(state.intents).toHaveLength(1);
});

test("repeated competing writes exhaust a bounded retry budget without publishing stale bytes", async () => {
  const f = await fixture();
  let conflicts = 0;
  const result = await Result.gen(() =>
    writeStoredTemplate({
      ...f.options,
      mode: { type: "new-version", userId: ids.userA1 },
      prepare: f.prepare,
      async writeObject(object) {
        await f.writeObject(object);
        conflicts += 1;
        const winner = await Result.gen(() =>
          writeStoredTemplate({
            ...f.options,
            mode: { type: "current-version" },
            prepare: f.prepare,
            writeObject: f.writeObject,
          }),
        );
        expect(Result.isOk(winner)).toBe(true);
        return S3_OBJECT_WRITE_CERTAINTY.CONFIRMED;
      },
    }),
  );
  expect(
    Result.isError(result) &&
      HandlerError.is(result.error) &&
      result.error.status,
  ).toBe(409);
  expect(conflicts).toBe(3);
  const state = await f.state();
  expect(state.versions).toHaveLength(1);
  expect(state.current?.manifest?.fields).toHaveLength(4);
  expect(state.audits).toHaveLength(3);
  expect(state.intents).toHaveLength(3);
  expect(state.intents.every(({ status }) => status === "orphaned")).toBe(true);
});
