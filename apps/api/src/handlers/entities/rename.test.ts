import { Result, panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { entities, fields } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createRenameEntityHandler } from "@/api/handlers/entities/rename-operation";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
let originalEntity: Awaited<ReturnType<typeof stored>>;
beforeAll(async () => {
  fixture = await getRlsFixture();
  originalEntity = await stored();
});
afterEach(async () => {
  if (!originalEntity) {
    throw new Error("Fixture entity missing");
  }
  await fixture.testDb
    .update(entities)
    .set({
      name: originalEntity.name,
      kind: originalEntity.kind,
      readOnly: originalEntity.readOnly,
      currentVersionId: originalEntity.currentVersionId,
      updatedAt: originalEntity.updatedAt,
    })
    .where(eq(entities.id, originalEntity.id));
  for (const field of originalEntity.currentVersion?.fields ?? []) {
    await fixture.testDb
      .update(fields)
      .set({ content: field.content })
      .where(eq(fields.id, field.id));
  }
});
afterAll(async () => {
  await releaseRlsFixture();
});
beforeEach(async () => {
  await fixture.testDb
    .update(entities)
    .set({ name: "previous.md", readOnly: false, kind: "document" })
    .where(eq(entities.id, fixture.ids.entityA1));
});

const invocation = (entityId = fixture.ids.entityA1) => {
  const { testDb, ids } = fixture;
  const enqueue = mock(async () => undefined);
  const flush = mock(async () => ({ failed: 0, repaired: 0 }));
  const audit = mock(async () => undefined);
  const rename = createRenameEntityHandler({
    enqueueEntitySearchRepairs: enqueue,
    flushEntitySearchRepairs: flush,
  });
  // Both matters are accessible: the handler must still enforce the selected matter.
  const safeDb = asTestRaw<SafeDb>(
    createSafeDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  return {
    enqueue,
    flush,
    audit,
    run: async () =>
      await Result.gen(() =>
        rename({
          safeDb,
          workspaceId: ids.wsA1,
          userId: ids.userA1,
          recordAuditEvent: audit,
          body: { entityId, name: "updated/name.md" },
        }),
      ),
  };
};

const stored = async () =>
  await fixture.testDb.query.entities.findFirst({
    where: { id: { eq: fixture.ids.entityA1 } },
    with: { currentVersion: { with: { fields: true } } },
  });

test("returns the same file metadata it commits without replacing field identity", async () => {
  const { run, enqueue, flush, audit } = invocation();
  const before = await stored();
  const result = await run();
  if (result.isErr()) {
    throw result.error;
  }
  const entity = await stored();
  const file = entity?.currentVersion?.fields.find(
    (field) => field.content.type === "file",
  );
  expect(result.value).toEqual({
    entityId: fixture.ids.entityA1,
    name: "updated/name.md",
    file: {
      fieldId: fixture.ids.fileFieldA1,
      fileName: sanitizeFilename("updated/name.md"),
    },
  });
  expect(entity?.name).toBe(result.value.name);
  expect(entity?.currentVersionId).toBe(before?.currentVersionId);
  expect(file?.id).toBe(result.value.file?.fieldId);
  const beforeContent = before?.currentVersion?.fields.find(
    (field) => field.content.type === "file",
  )?.content;
  if (beforeContent?.type !== "file" || !result.value.file) {
    panic("Fixture rename must include file metadata");
  }
  expect(file?.content).toEqual({
    ...beforeContent,
    fileName: result.value.file.fileName,
  });
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(flush).toHaveBeenCalledWith([fixture.ids.entityA1]);
  expect(audit).toHaveBeenCalledTimes(1);
});

test("returns an explicit absent file when the current version has no file", async () => {
  await fixture.testDb
    .update(entities)
    .set({ kind: "folder" })
    .where(eq(entities.id, fixture.ids.entityA1));
  const original = await fixture.testDb.query.fields.findFirst({
    where: { id: { eq: fixture.ids.fileFieldA1 } },
  });
  if (!original) {
    throw new Error("Fixture file missing");
  }
  await fixture.testDb
    .update(fields)
    .set({ content: { type: "text", version: 1, value: "folder" } })
    .where(eq(fields.id, original.id));
  try {
    const result = await invocation().run();
    if (result.isErr()) {
      throw result.error;
    }
    expect(result.value).toEqual({
      entityId: fixture.ids.entityA1,
      name: "updated/name.md",
      file: null,
    });
  } finally {
    await fixture.testDb
      .update(fields)
      .set({ content: original.content })
      .where(eq(fields.id, original.id));
  }
});

test("a read-only rename returns 409 and leaves stored metadata unchanged", async () => {
  await fixture.testDb
    .update(entities)
    .set({ readOnly: true })
    .where(eq(entities.id, fixture.ids.entityA1));
  const before = await stored();
  const { run, enqueue, flush, audit } = invocation();
  const result = await run();
  if (result.isOk()) {
    throw new Error("Expected read-only refusal");
  }
  expect(result.error).toMatchObject({
    status: 409,
    message: "Entity is read-only",
  });
  expect(await stored()).toEqual(before);
  expect(enqueue).not.toHaveBeenCalled();
  expect(flush).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
});

test("an entity in another accessible matter returns 404 without writes", async () => {
  const before = await fixture.testDb.query.entities.findFirst({
    where: { id: { eq: fixture.ids.entityA2 } },
  });
  expect(before?.workspaceId).toBe(fixture.ids.wsA2);
  const { run, enqueue, flush, audit } = invocation(fixture.ids.entityA2);
  const result = await run();
  if (result.isOk()) {
    throw new Error("Expected selected-matter refusal");
  }
  expect(result.error).toMatchObject({
    status: 404,
    message: "Entity not found",
  });
  expect(
    await fixture.testDb.query.entities.findFirst({
      where: { id: { eq: fixture.ids.entityA2 } },
    }),
  ).toEqual(before);
  expect(enqueue).not.toHaveBeenCalled();
  expect(flush).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
});

test("renames an ordinary task without creating a version or file field", async () => {
  await fixture.testDb
    .update(entities)
    .set({ kind: "task", currentVersionId: null })
    .where(eq(entities.id, fixture.ids.entityA1));
  const { run, enqueue, audit } = invocation();
  const result = await run();
  if (result.isErr()) {
    throw result.error;
  }
  expect(result.value).toEqual({
    entityId: fixture.ids.entityA1,
    name: "updated/name.md",
    file: null,
  });
  const task = await stored();
  expect(task?.name).toBe("updated/name.md");
  expect(task?.currentVersionId).toBeNull();
  expect(task?.currentVersion).toBeNull();
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(audit).toHaveBeenCalledTimes(1);
});
