import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { userFiles } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import readUserFileContent from "./read-content";

const ids = createTestIds();
let database: TestDatabase;
let fake: FakeS3;

// timeout: migrates and seeds the shared test database on a first run.
beforeAll(async () => {
  fake = startFakeS3();
  database = await getTestDb();
  await setupRlsTestData(database, ids);
}, 30_000);

afterAll(async () => {
  fake.stop();
  await releaseTestDb();
});

const storedFile = async (fileName: string, mimeType: string) => {
  const id = createSafeId<"userFile">();
  await database.insert(userFiles).values({
    id,
    userId: ids.userA1,
    fileName,
    mimeType,
    sizeBytes: 10,
    sha256Hex: "e".repeat(64),
    s3Key: `${ids.orgA}/${id}.bin`,
    threadId: ids.chatThreadWorkspaceA1,
  });
  return id;
};

/** Where the route sends the browser, and what the signed link tells S3. */
const deliveryOf = async (
  fileId: Parameters<typeof readUserFileContent.handler>[0]["params"]["fileId"],
) => {
  const request = new Request("https://example.test/content");
  const response = await readUserFileContent.handler(
    createTestHandlerContext<Parameters<typeof readUserFileContent.handler>[0]>(
      {
        scopedDb: NO_DB,
        params: { fileId },
        session: { activeOrganizationId: ids.orgA, id: "session" },
        user: { id: ids.userA1 },
        workspaceId: ids.wsA1,
        safeDb: createSafeDb(database, [ids.wsA1], ids.orgA, ids.userA1),
        audit: createAuditRecorder({
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          userId: ids.userA1,
          request,
          server: null,
        }),
        request,
      },
    ),
  );
  if (!(response instanceof Response)) {
    throw new TypeError("Expected a redirect to the signed link");
  }
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  return location.searchParams.get("response-content-disposition");
};

describe("delivering a stored chat file", () => {
  test("a run's HTML report can only be downloaded, under its own name", async () => {
    const disposition = await deliveryOf(
      await storedFile("report.html", "text/html"),
    );
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("report.html");
  });

  test("a PDF keeps reading in the browser", async () => {
    expect(
      await deliveryOf(await storedFile("brief.pdf", "application/pdf")),
    ).toBeNull();
  });
});
