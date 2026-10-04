import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { fields, properties } from "@/api/db/schema";
import type { PropertyContent } from "@/api/db/schema-validators";
import { createScopedDb, createSafeDb } from "@/api/db/scoped";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { serverBuiltFileEncryption } from "@/api/lib/files/detect-file-encryption";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { validateEntityCreate } from "@/api/lib/uploads/entity-create";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import updateProperty from "./update";

type Context = Parameters<typeof updateProperty.handler>[0];
const ids = createTestIds();
let db: TestDatabase;
beforeAll(
  async () => {
    db = await getTestDb();
    await setupRlsTestData(db, ids);
    await db
      .update(properties)
      .set({ system: true, kinds: ["document"] })
      .where(eq(properties.id, ids.filePropertyA1));
  },
  { timeout: 30_000 },
);
afterAll(releaseTestDb);

const contents = {
  file: { version: 1, type: "file" },
  text: { version: 1, type: "text" },
  date: { version: 1, type: "date" },
  int: { version: 1, type: "int" },
  money: { version: 1, type: "money", currency: null },
  person: { version: 1, type: "person" },
  "single-select": {
    version: 1,
    type: "single-select",
    options: [],
    fallback: null,
  },
  "multi-select": {
    version: 1,
    type: "multi-select",
    options: [],
    fallback: null,
  },
} as const satisfies Record<PropertyContent["type"], PropertyContent>;

const runUpdate = async ({
  content,
  name,
  file,
  ai,
}: {
  content: PropertyContent;
  name: string;
  file: boolean;
  ai: boolean;
}) => {
  const safeDb = createSafeDb(db, [ids.wsA1], ids.orgA, ids.userA1);
  return await updateProperty.handler(
    asTestRaw<Context>({
      safeDb,
      scopedDb: async () => {},
      request: new Request("https://example.test/v1/properties"),
      route: "/v1/properties/:workspaceId/:propertyId",
      memberRole: sessionMemberRole("owner"),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      workspaceId: ids.wsA1,
      params: { propertyId: file ? ids.filePropertyA1 : ids.propertyA1 },
      body: {
        name,
        content,
        tool: ai
          ? {
              version: 1,
              type: "ai-model",
              prompt: "Read the document",
              dependencies: [],
            }
          : { version: 1, type: "manual-input" },
      },
      recordAuditEvent: async () => {},
    }),
  );
};

const customContents = Object.values(contents).filter(
  (content) => content.type !== "file",
);
test.each(customContents)(
  "keeps $type custom columns outside the file lifecycle",
  async (content) => {
    await db
      .update(properties)
      .set({ content })
      .where(eq(properties.id, ids.propertyA1));
    const before = await db.query.properties.findFirst({
      where: { id: { eq: ids.propertyA1 } },
    });
    expect(
      await runUpdate({
        content: contents.file,
        name: "File",
        file: false,
        ai: false,
      }),
    ).toMatchObject({
      code: 422,
      response: { code: "file_property_type_immutable", retryable: false },
    });
    expect(
      await db.query.properties.findFirst({
        where: { id: { eq: ids.propertyA1 } },
      }),
    ).toEqual(before);
  },
);
test.each(customContents)(
  "preserves the file column when requesting $type",
  async (content) => {
    const before = await db.query.properties.findFirst({
      where: { id: { eq: ids.filePropertyA1 } },
    });
    const beforeFields = await db.query.fields.findMany({
      where: { propertyId: { eq: ids.filePropertyA1 } },
      limit: 10,
    });
    expect(beforeFields.at(0)?.content.type).toBe("file");
    const response = await runUpdate({
      content,
      name: "Changed",
      file: true,
      ai: false,
    });
    expect(response).toMatchObject({
      code: 422,
      response: { code: "file_property_type_immutable", retryable: false },
    });
    expect(
      await db.query.properties.findFirst({
        where: { id: { eq: ids.filePropertyA1 } },
      }),
    ).toEqual(before);
    expect(
      await db.query.fields.findMany({
        where: { propertyId: { eq: ids.filePropertyA1 } },
        limit: 10,
      }),
    ).toEqual(beforeFields);
  },
);

test("non-system file columns retain their type", async () => {
  await db
    .update(properties)
    .set({ system: false })
    .where(eq(properties.id, ids.filePropertyA1));
  const before = await db.query.properties.findFirst({
    where: { id: { eq: ids.filePropertyA1 } },
  });
  expect(
    await runUpdate({
      content: contents.text,
      name: "Custom documents",
      file: true,
      ai: false,
    }),
  ).toMatchObject({
    code: 422,
    response: { code: "file_property_type_immutable", retryable: false },
  });
  expect(
    await db.query.properties.findFirst({
      where: { id: { eq: ids.filePropertyA1 } },
    }),
  ).toEqual(before);
  await db
    .update(properties)
    .set({ system: true })
    .where(eq(properties.id, ids.filePropertyA1));
});

test("file type refusal precedes AI tool validation", async () => {
  expect(
    await runUpdate({
      content: contents.file,
      name: "Converted",
      file: false,
      ai: true,
    }),
  ).toMatchObject({
    code: 422,
    response: {
      code: "file_property_type_immutable",
      retryable: false,
      hint: expect.stringContaining("properties.update"),
    },
  });
});

test("file column updates preserve document references", async () => {
  await assertProperty(
    "file column updates preserve document references",
    fc.asyncProperty(
      fc.constantFrom(...Object.values(contents)),
      fc.string({ minLength: 1, maxLength: 32 }),
      fc.boolean(),
      fc.boolean(),
      async (content, name, file, ai) => {
        const propertyId = file ? ids.filePropertyA1 : ids.propertyA1;
        const before = await db.query.properties.findFirst({
          where: { id: { eq: propertyId } },
        });
        const beforeFields = await db
          .select()
          .from(fields)
          .where(eq(fields.propertyId, ids.filePropertyA1));
        const response = await runUpdate({ content, name, file, ai });
        const after = await db.query.properties.findFirst({
          where: { id: { eq: propertyId } },
        });
        if (
          file !== (content.type === "file") ||
          (content.type === "file" && ai)
        ) {
          expect(response).toMatchObject({ code: 422 });
          if (file !== (content.type === "file")) {
            expect(response).toMatchObject({
              response: {
                code: "file_property_type_immutable",
                retryable: false,
              },
            });
          }
          expect(after).toEqual(before);
        } else {
          expect(response).toEqual({});
          expect(after?.content).toEqual(content);
          expect(after?.name).toBe(name);
        }
        expect(
          await db
            .select()
            .from(fields)
            .where(eq(fields.propertyId, ids.filePropertyA1)),
        ).toEqual(beforeFields);
        const safeDb = asTestRaw<Context["safeDb"]>(
          createSafeDb(db, [ids.wsA1], ids.orgA, ids.userA1),
        );
        const uploadValidation = await Result.gen(() =>
          validateEntityCreate({
            safeDb,
            workspaceId: ids.wsA1,
            propertyId: ids.filePropertyA1,
            parentId: null,
          }),
        );
        expect(uploadValidation.isOk()).toBe(true);
      },
    ),
    { numRuns: 30 },
  );
});

test("renaming a file column retains its scope and generated document creation", async () => {
  expect(
    await runUpdate({
      content: contents.file,
      name: "Documents",
      file: true,
      ai: false,
    }),
  ).toEqual({});
  const column = await db.query.properties.findFirst({
    where: { id: { eq: ids.filePropertyA1 } },
  });
  expect(column).toMatchObject({
    system: true,
    kinds: ["document"],
    content: contents.file,
  });
  const fake = startFakeS3();
  try {
    const created = await createEntityFromBuffer({
      scopedDb: asTestRaw<
        Parameters<typeof createEntityFromBuffer>[0]["scopedDb"]
      >(createScopedDb(db, [ids.wsA1], ids.orgA, ids.userA1)),
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      recordAuditEvent: async () => {},
      buffer: new TextEncoder().encode("Generated document"),
      fileName: "generated.txt",
      mimeType: "text/plain",
      encryption: serverBuiltFileEncryption(),
      dependencies: {
        broadcastWorkspaceResourceUpdated: () => {},
        processExtraction: async () => {},
        enqueueImageThumbnailOrMarkFailed: async () => {},
        enqueuePdfDerivativeOrMarkFailed: async () => {},
        requestNativeExtractionRun: async () => null,
      },
    });
    expect(created.isOk()).toBe(true);
    if (created.isErr()) {
      throw created.error;
    }
    const field = await db.query.fields.findFirst({
      where: { id: { eq: created.value.fieldId } },
    });
    expect(field?.propertyId).toBe(ids.filePropertyA1);
    expect(field?.content.type).toBe("file");
    expect(fake.requests.some((request) => request.method === "PUT")).toBe(
      true,
    );
  } finally {
    fake.stop();
  }
});
