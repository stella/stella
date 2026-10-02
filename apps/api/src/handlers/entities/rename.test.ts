import { Result } from "better-result";
import { expect, mock, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";
import { createRenameEntityHandler } from "@/api/handlers/entities/rename";
import { toSafeId } from "@/api/lib/branded-types";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const entityId = toSafeId<"entity">("entity");
const fieldId = toSafeId<"field">("field");
const workspaceId = toSafeId<"workspace">("matter");
const content = {
  type: "file",
  version: 1,
  id: "file",
  fileName: sanitizeFilename("previous.md"),
  mimeType: "text/markdown",
  sizeBytes: 12,
  encrypted: false,
  sha256Hex: "a".repeat(64),
  pdfFileId: null,
} satisfies FieldContent;

const fixture = ({
  kind,
  readOnly,
}: {
  kind: "document" | "folder";
  readOnly: boolean;
}) => {
  const writes: unknown[] = [];
  const enqueue = mock(async () => undefined);
  const flush = mock(async () => ({ failed: 0, repaired: 0 }));
  const audit = mock(async () => undefined);
  const { safeDb } = createScopedDbMock({
    select: () => ({
      from: () => ({
        where: () => ({
          for: async () => [
            { id: entityId, kind, name: "previous.md", readOnly },
          ],
        }),
      }),
    }),
    update: () => ({
      set: (values: unknown) => ({
        where: async () => {
          writes.push(values);
        },
      }),
    }),
    query: {
      entities: {
        findFirst: async () => ({
          currentVersion: {
            fields: kind === "document" ? [{ id: fieldId, content }] : [],
          },
        }),
      },
    },
  });
  const rename = createRenameEntityHandler({
    enqueueEntitySearchRepairs: enqueue,
    flushEntitySearchRepairs: flush,
  });
  return {
    writes,
    enqueue,
    flush,
    audit,
    run: async () =>
      await Result.gen(() =>
        rename({
          safeDb,
          workspaceId,
          recordAuditEvent: audit,
          body: { entityId, name: "updated/name.md" },
        }),
      ),
  };
};

test("returns the same file metadata it commits without replacing field identity", async () => {
  const { run, writes, enqueue, flush, audit } = fixture({
    kind: "document",
    readOnly: false,
  });
  const result = await run();
  expect(result.isOk()).toBe(true);
  if (result.isErr()) {
    throw result.error;
  }
  expect(result.value).toEqual({
    entityId,
    name: "updated/name.md",
    file: { fieldId, fileName: "updated_name.md" },
  });
  expect(writes).toEqual([
    { name: result.value.name, updatedAt: expect.any(Date) },
    { content: { ...content, fileName: result.value.file?.fileName } },
  ]);
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(flush).toHaveBeenCalledWith([entityId]);
  expect(audit).toHaveBeenCalledTimes(1);
});

test("returns an explicit absent file for a folder rename", async () => {
  const { run, writes } = fixture({ kind: "folder", readOnly: false });
  const result = await run();
  expect(result.isOk()).toBe(true);
  if (result.isErr()) {
    throw result.error;
  }
  expect(result.value).toEqual({
    entityId,
    name: "updated/name.md",
    file: null,
  });
  expect(writes).toHaveLength(1);
});

test("a refused rename emits no confirmed metadata or writes", async () => {
  const { run, writes, enqueue, flush, audit } = fixture({
    kind: "document",
    readOnly: true,
  });
  const result = await run();
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    throw new Error("Expected read-only refusal");
  }
  expect(result.error.message).toBe("Entity is read-only");
  expect(writes).toEqual([]);
  expect(enqueue).not.toHaveBeenCalled();
  expect(flush).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
});
