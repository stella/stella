import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { envBase } from "@/api/env-base";
import { toSafeId } from "@/api/lib/branded-types";
import {
  loadEntityVersionDocxBuffer,
  loadEntityVersionFileBuffer,
  resolveEntityVersionFile,
} from "@/api/lib/entity-versions/load-entity-version-file-buffer";
import { createFileKey } from "@/api/lib/files/utils";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = toSafeId<"organization">("org_1");
const workspaceId = toSafeId<"workspace">("ws_1");
const entityId = toSafeId<"entity">("entity_1");
const versionId = toSafeId<"entityVersion">("version_1");
const fileFieldId = toSafeId<"field">("field_1");
const otherFieldId = toSafeId<"field">("field_2");
const fileId = "file_1";

type StoredEntity = {
  currentVersionId: string | null;
  readOnly: boolean;
};

type StoredField = {
  id: string;
  propertyId: string;
  content:
    | {
        type: "file";
        id: string;
        fileName: string;
        mimeType: string;
        encrypted: boolean;
      }
    | { type: "text"; value: string };
};

let entity: StoredEntity;
let versionFields: StoredField[];
let fake: FakeS3;

const pdfField = (
  overrides: Partial<Extract<StoredField["content"], { type: "file" }>> = {},
): StoredField => ({
  id: fileFieldId,
  propertyId: "prop_1",
  content: {
    type: "file",
    id: fileId,
    fileName: "brief.pdf",
    mimeType: PDF_MIME_TYPE,
    encrypted: false,
    ...overrides,
  },
});

const safeDb = asTestRaw<SafeDb>(
  async <T>(run: (tx: Transaction) => Promise<T>) =>
    await Result.tryPromise({
      try: async () =>
        await run(
          asTestRaw<Transaction>({
            query: {
              entities: { findFirst: async () => entity },
              entityVersions: {
                findFirst: async () => ({
                  id: versionId,
                  fields: versionFields,
                }),
              },
            },
          }),
        ),
      catch: (cause) => cause,
    }),
);

const baseOptions = { safeDb, workspaceId, entityId, fileFieldId };

/** The error's status, or `null` for a success, which no status matches. */
const errorStatus = <T>(
  result: Result<T, { status: number }>,
): number | null => (Result.isError(result) ? result.error.status : null);

describe("resolveEntityVersionFile", () => {
  beforeEach(() => {
    entity = { currentVersionId: versionId, readOnly: false };
    versionFields = [pdfField()];
  });

  test("resolves the current version's file with its identity and type", async () => {
    const resolved = Result.unwrap(
      await resolveEntityVersionFile({ ...baseOptions, allowReadOnly: true }),
    );
    expect(resolved).toEqual({
      entityId,
      workspaceId,
      entityVersionId: versionId,
      fileId: toSafeId<"userFile">(fileId),
      fileName: "brief.pdf",
      mimeType: PDF_MIME_TYPE,
      filePropertyId: toSafeId<"property">("prop_1"),
    });
  });

  test("rejects a file of another type when one is expected", async () => {
    expect(
      errorStatus(
        await resolveEntityVersionFile({
          ...baseOptions,
          expectMimeType: DOCX_MIME_TYPE,
        }),
      ),
    ).toBe(400);
  });

  test("rejects an encrypted file, a non-file field, and a missing field", async () => {
    versionFields = [pdfField({ encrypted: true })];
    expect(errorStatus(await resolveEntityVersionFile(baseOptions))).toBe(400);

    versionFields = [
      {
        id: fileFieldId,
        propertyId: "prop_1",
        content: { type: "text", value: "" },
      },
    ];
    expect(errorStatus(await resolveEntityVersionFile(baseOptions))).toBe(400);

    versionFields = [{ ...pdfField(), id: otherFieldId }];
    expect(errorStatus(await resolveEntityVersionFile(baseOptions))).toBe(400);
  });

  test("rejects a read-only entity unless the caller only reads", async () => {
    entity = { currentVersionId: versionId, readOnly: true };
    expect(errorStatus(await resolveEntityVersionFile(baseOptions))).toBe(409);
    expect(
      Result.isOk(
        await resolveEntityVersionFile({ ...baseOptions, allowReadOnly: true }),
      ),
    ).toBe(true);
  });

  test("reports a missing document", async () => {
    entity = { currentVersionId: null, readOnly: false };
    expect(errorStatus(await resolveEntityVersionFile(baseOptions))).toBe(404);
  });
});

describe("loadEntityVersionFileBuffer", () => {
  beforeEach(() => {
    entity = { currentVersionId: versionId, readOnly: false };
    versionFields = [pdfField()];
    fake = startFakeS3();
  });

  afterEach(() => {
    fake.stop();
  });

  test("reads the bytes under the file's own key", async () => {
    const key = createFileKey({
      organizationId,
      workspaceId,
      fileId,
      mimeType: PDF_MIME_TYPE,
    });
    fake.put(envBase.S3_BUCKET, key, new Uint8Array([1, 2, 3]), PDF_MIME_TYPE);

    const loaded = Result.unwrap(
      await loadEntityVersionFileBuffer({ ...baseOptions, organizationId }),
    );
    expect(new Uint8Array(loaded.buffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(loaded.mimeType).toBe(PDF_MIME_TYPE);
    expect(
      fake.requests
        .filter((request) => request.method === "GET")
        .map((request) => request.key),
    ).toEqual([key]);
  });

  test("the DOCX loader refuses any other file type before reading", async () => {
    expect(
      errorStatus(
        await loadEntityVersionDocxBuffer({ ...baseOptions, organizationId }),
      ),
    ).toBe(400);
    expect(fake.requests).toHaveLength(0);
  });
});
