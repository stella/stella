import { afterAll, beforeAll, expect, test } from "bun:test";

import { createSafeDb } from "@/api/db/scoped";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import {
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createReadUserFileVisual } from "./read-visual";

const ids = createTestIds();
let database: TestDatabase;
beforeAll(async () => {
  database = await getTestDb();
  await setupRlsTestData(database, ids);
}, 30_000);
afterAll(releaseTestDb);

const document = {
  title: "Court overview",
  html: "<p>Overview</p>",
  data: {},
  links: [],
};
const reader = createReadUserFileVisual(async () =>
  testScannedFile({
    bytes: new TextEncoder().encode(JSON.stringify(document)).buffer,
    mimeType: "text/plain",
  }),
);
const read = async (
  fileId: Parameters<typeof reader.handler>[0]["params"]["fileId"],
  fileReader = reader,
) => {
  const request = new Request("https://example.test/visual");
  const record = createAuditRecorder({
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
    request,
    server: null,
  });
  return await fileReader.handler(
    createTestHandlerContext<Parameters<typeof reader.handler>[0]>({
      scopedDb: NO_DB,
      params: { fileId },
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      workspaceId: ids.wsA1,
      safeDb: createSafeDb(database, [ids.wsA1], ids.orgA, ids.userA1),
      audit: record,
      request,
    }),
  );
};

test("reads the owner's stored generated view", async () => {
  const response = await read(ids.userFileWorkspaceA1);
  expect(response).toBeInstanceOf(Response);
  if (!(response instanceof Response)) {
    throw new TypeError("Expected a visual response");
  }
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject(document);
});

test("returns not found for an unknown file id", async () => {
  expect(await read(createSafeId<"userFile">())).toMatchObject({
    code: 404,
    response: { message: "User file not found" },
  });
});

test.each(["Ordinary text attachment", JSON.stringify({ title: "Example" })])(
  "returns a typed 422 envelope for a stored attachment without a generated view (%s)",
  async (content) => {
    const fileReader = createReadUserFileVisual(async () =>
      testScannedFile({
        bytes: new TextEncoder().encode(content).buffer,
        mimeType: "text/plain",
      }),
    );
    expect(await read(ids.userFileWorkspaceA1, fileReader)).toMatchObject({
      code: 422,
      response: { message: "The attachment is not a generated view" },
    });
  },
);
