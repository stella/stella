import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import {
  BROWSER_DOWNLOAD_REFUSAL_CODE,
  browserDownloadFiledSchema,
} from "@stll/api-contract/browser-downloads";
import { sha256Hex } from "@stll/sha256/bun";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db-types";
import { entities, entityVersions, userFiles } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import type { UploadUserFileDependencies } from "@/api/handlers/chat/upload-files";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { largeScannedPdf } from "@/api/tests/helpers/large-pdf";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createFileChatThreadBrowserDownload } from "./chat-thread";

// The chat page filing what the member's browser downloaded for one of
// their chats on stella's models: the real handler, filing owner, security
// scan, PDF checks and database, with a fake object store.

// timeout: each file goes through the real security scan and PDF checks.
setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let fake: FakeS3;
let pdf: Uint8Array;

let fileDownload: ReturnType<typeof createFileChatThreadBrowserDownload>;

type Ctx = Parameters<
  ReturnType<typeof createFileChatThreadBrowserDownload>["handler"]
>[0];

const ORIGIN = {
  sourceUrl: "https://fixture-library.test/doc/1/file",
  pageUrl: "https://fixture-library.test/doc/1",
  downloadedAt: "2026-11-25T09:30:00.000Z",
};

const ROUTE = "/v1/chat/threads/:threadId/browser-downloads";

type Post = {
  threadId: SafeId<"chatThread">;
  bytes?: Uint8Array;
  name?: string;
  pageUrl?: string | null;
  organizationId?: SafeId<"organization">;
  userId?: SafeId<"user">;
  /** The matters the member reaches now. */
  reachable?: SafeId<"workspace">[];
};

const post = async ({
  threadId,
  bytes = pdf,
  name = "Decision 1.pdf",
  pageUrl = ORIGIN.pageUrl,
  organizationId = ids.orgA,
  userId = ids.userA1,
  reachable = [ids.wsA1, ids.wsA2],
}: Post) => {
  const request = new Request(`http://localhost/v1/chat/threads/${threadId}`);
  return await fileDownload.handler(
    asTestRaw<Ctx>({
      body: {
        downloadedAt: ORIGIN.downloadedAt,
        file: new File([new Uint8Array(bytes)], name),
        sourceUrl: ORIGIN.sourceUrl,
        ...(pageUrl === null ? {} : { pageUrl }),
      },
      getWorkspaceAccess: async (workspaceId: SafeId<"workspace">) =>
        await Promise.resolve(
          reachable.includes(workspaceId)
            ? { id: workspaceId, status: "active" as const }
            : null,
        ),
      memberRole: sessionMemberRole("member"),
      params: { threadId },
      recordAuditEvent: createAuditRecorder({
        organizationId,
        workspaceId: null,
        userId,
        request,
        server: null,
      }),
      request,
      route: ROUTE satisfies ApiRoutePath,
      safeDb: asTestRaw<SafeDb>(
        createSafeDb(testDb, reachable, organizationId, userId),
      ),
      scopedDb: asTestRaw<ScopedDb>(
        createScopedDb(testDb, reachable, organizationId, userId),
      ),
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
    }),
  );
};

const filedOf = (answer: unknown) => {
  expect(answer).not.toBeInstanceOf(HttpStatusResponse);
  return v.parse(browserDownloadFiledSchema, answer);
};

const refusalOf = (answer: unknown) => {
  if (!(answer instanceof HttpStatusResponse)) {
    throw new TypeError(`Expected a refusal, got ${JSON.stringify(answer)}`);
  }
  return { body: answer.response, status: answer.code };
};

const documentsIn = async (workspaceId: SafeId<"workspace">) =>
  await testDb.$count(entities, eq(entities.workspaceId, workspaceId));

beforeAll(async () => {
  fake = startFakeS3();
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  pdf = await largeScannedPdf({ minBytes: 2048, text: "Judgment 7" });
  fileDownload = createFileChatThreadBrowserDownload({
    filing: {
      uploads: {
        organizationFileUsageDb:
          asTestRaw<UploadUserFileDependencies["organizationFileUsageDb"]>(
            testDb,
          ),
      },
    },
  });
});

afterAll(async () => {
  fake.stop();
  await releaseRlsFixture();
});

describe("the chat page filing a download its chat's tab made", () => {
  test("lands in the chat's own matter as a document that keeps where it came from, and the same bytes name it again", async () => {
    const before = await documentsIn(ids.wsA1);

    const filed = filedOf(await post({ threadId: ids.chatThreadWorkspaceA1 }));

    expect(filed).toMatchObject({
      duplicate: false,
      type: "document",
      workspaceId: ids.wsA1,
    });
    if (filed.type !== "document") {
      throw new Error("Expected a document");
    }
    const versions = await testDb
      .select({ source: entityVersions.source })
      .from(entityVersions)
      .where(eq(entityVersions.entityId, toSafeId<"entity">(filed.entityId)));
    expect(versions).toEqual([
      {
        source: {
          kind: "browser-download",
          ...ORIGIN,
          contentHash: sha256Hex(pdf),
        },
      },
    ]);
    expect(await documentsIn(ids.wsA1)).toBe(before + 1);

    const again = filedOf(
      await post({
        name: "Decision 1 (again).pdf",
        pageUrl: null,
        threadId: ids.chatThreadWorkspaceA1,
      }),
    );
    expect(again).toEqual({ ...filed, duplicate: true });
    expect(await documentsIn(ids.wsA1)).toBe(before + 1);
  });

  test("a chat in no matter keeps the file with the chat", async () => {
    const before = await documentsIn(ids.wsA1);

    const filed = filedOf(
      await post({
        bytes: await largeScannedPdf({ minBytes: 2048, text: "Chat file" }),
        threadId: ids.chatThreadGlobalA1,
      }),
    );

    if (filed.type !== "chat_file") {
      throw new Error("Expected a chat file");
    }
    const rows = await testDb
      .select({ threadId: userFiles.threadId, mimeType: userFiles.mimeType })
      .from(userFiles)
      .where(eq(userFiles.id, toSafeId<"userFile">(filed.fileId)));
    expect(rows).toEqual([
      { threadId: ids.chatThreadGlobalA1, mimeType: "application/pdf" },
    ]);
    expect(await documentsIn(ids.wsA1)).toBe(before);
  });

  test("another member's chat, or a chat in another organization, files nothing", async () => {
    const beforeA1 = await documentsIn(ids.wsA1);
    const bytes = await largeScannedPdf({ minBytes: 2048, text: "Never" });

    for (const threadId of [
      ids.chatThreadWorkspaceA1UserA2,
      ids.chatThreadWorkspaceB1UserA1,
    ]) {
      // await-in-loop: two refusals, one after the other.
      const refused = refusalOf(await post({ bytes, threadId }));
      expect(refused.status).toBe(404);
      expect(refused.body).toMatchObject({
        code: BROWSER_DOWNLOAD_REFUSAL_CODE.noChat,
      });
    }
    expect(await documentsIn(ids.wsA1)).toBe(beforeA1);
  });

  test("a matter the member no longer reaches is refused, never swapped for another", async () => {
    const beforeA1 = await documentsIn(ids.wsA1);
    const beforeA2 = await documentsIn(ids.wsA2);

    const refused = refusalOf(
      await post({
        bytes: await largeScannedPdf({ minBytes: 2048, text: "Gone" }),
        reachable: [ids.wsA2],
        threadId: ids.chatThreadWorkspaceA1,
      }),
    );

    expect(refused.status).toBe(404);
    expect(await documentsIn(ids.wsA1)).toBe(beforeA1);
    expect(await documentsIn(ids.wsA2)).toBe(beforeA2);
  });

  test("a file that is not a PDF is refused with its reason, and nothing is stored", async () => {
    const before = await documentsIn(ids.wsA1);

    const refused = refusalOf(
      await post({
        bytes: new TextEncoder().encode("<html>Sign in</html>"),
        threadId: ids.chatThreadWorkspaceA1,
      }),
    );

    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      code: BROWSER_DOWNLOAD_REFUSAL_CODE.notPdf,
    });
    expect(await documentsIn(ids.wsA1)).toBe(before);
  });
});
