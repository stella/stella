import { Result } from "better-result";
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
  localRunBrowserDownloadPath,
} from "@stll/api-contract/browser-downloads";
import { DESKTOP_RUNNER_PROTOCOL } from "@stll/api-contract/desktop-runner";
import { sha256Hex } from "@stll/sha256/bun";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db-types";
import {
  desktopRunnerRuns,
  desktopRunners,
  entities,
  entityVersions,
  userFiles,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import type { UploadUserFileDependencies } from "@/api/handlers/chat/upload-files";
import { routes } from "@/api/http/route";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { readOpenRunChatThread } from "@/api/lib/desktop-runner/store";
import { AGENT_RUN_TOKEN_PURPOSE } from "@/api/mcp/constants";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { largeScannedPdf } from "@/api/tests/helpers/large-pdf";
import { serveRoutesForTest } from "@/api/tests/helpers/serve-routes";
import type { TestServer } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createFileLocalRunBrowserDownload } from "./local-run";

// timeout: each file goes through the real security scan, PDF checks and a
// fake object store.
setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let fake: FakeS3;
let server: TestServer;
/** A real one-page PDF, the same bytes for every test that files it. */
let pdf: Uint8Array;

type Claims = {
  sub: string;
  org_id: string;
  run_id: string;
  purpose: string;
  scope: string;
  workspace_ids: string[];
};

const tokens = new Map<string, Claims>();

const tokenFor = (runId: string, workspaceIds: string[]) => {
  const token = `token-${Bun.randomUUIDv7()}`;
  tokens.set(token, {
    sub: ids.userA1,
    org_id: ids.orgA,
    run_id: runId,
    purpose: AGENT_RUN_TOKEN_PURPOSE,
    scope: "stella:read stella:chat",
    workspace_ids: workspaceIds,
  });
  return token;
};

const insertRun = async (threadId: string) => {
  const runId = Bun.randomUUIDv7();
  const desktopId = Bun.randomUUIDv7();
  const seen = new Date("2026-01-01T00:00:00.000Z");
  await testDb.insert(desktopRunners).values({
    userId: ids.userA1,
    organizationId: ids.orgA,
    desktopId,
    deviceJkt: "jkt",
    keyId: "key",
    sessionId: Bun.randomUUIDv7(),
    instanceId: "api-elsewhere",
    connection: "connected",
    protocol: DESKTOP_RUNNER_PROTOCOL.current,
    appVersion: "1.4.0",
    sidecarVersion: "1.4.0",
    harnesses: [],
    connectedAt: seen,
    lastSeenAt: seen,
  });
  await testDb.insert(desktopRunnerRuns).values({
    runId,
    userId: ids.userA1,
    organizationId: ids.orgA,
    desktopId,
    deviceJkt: "jkt",
    harness: "codex",
    harnessVersion: "1.0.0",
    workspaceIds: [],
    state: "running",
    leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    chatThreadId: threadId,
  });
  return runId;
};

const ORIGIN = {
  sourceUrl: "https://fixture-library.test/doc/1/file",
  pageUrl: "https://fixture-library.test/doc/1",
  downloadedAt: "2026-11-25T09:30:00.000Z",
};

const post = async (
  runId: string,
  token: string,
  {
    bytes = pdf,
    name = "Decision 1.pdf",
    pageUrl = ORIGIN.pageUrl,
    sourceUrl = ORIGIN.sourceUrl,
  }: {
    bytes?: Uint8Array;
    name?: string;
    pageUrl?: string | null;
    sourceUrl?: string;
  } = {},
) => {
  const body = new FormData();
  body.set("file", new File([new Uint8Array(bytes)], name));
  body.set("sourceUrl", sourceUrl);
  if (pageUrl !== null) {
    body.set("pageUrl", pageUrl);
  }
  body.set("downloadedAt", ORIGIN.downloadedAt);
  return await fetch(new URL(localRunBrowserDownloadPath(runId), server.url), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body,
  });
};

const filedOf = async (response: Response) => {
  expect(response.status).toBe(200);
  const answer: unknown = await response.json();
  return v.parse(browserDownloadFiledSchema, answer);
};

const documentsIn = async (workspaceId: SafeId<"workspace">) =>
  await testDb.$count(entities, eq(entities.workspaceId, workspaceId));

beforeAll(async () => {
  fake = startFakeS3();
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  pdf = await largeScannedPdf({ minBytes: 2048, text: "Judgment 42" });
  const handler = createFileLocalRunBrowserDownload({
    verifyToken: async (token) => {
      const claims = token === undefined ? undefined : tokens.get(token);
      if (claims === undefined) {
        throw Object.assign(new Error("Invalid token"), {
          name: "APIError",
          status: "UNAUTHORIZED",
        });
      }
      return await Promise.resolve(claims);
    },
    resolveContext: async (session, { request }) => {
      const organizationId = toSafeId<"organization">(session.organizationId);
      const userId = toSafeId<"user">(session.userId);
      // The token's matters, as the member reaches them.
      const workspaceIds = (session.workspaceIds ?? []).map((id) =>
        toSafeId<"workspace">(id),
      );
      return await Promise.resolve({
        accessibleWorkspaces: workspaceIds.map((id) => ({
          id,
          status: "active" as const,
        })),
        billingAccess: false,
        memberRole: "member" as const,
        pinServerValidatedWorkspaceId: (workspaceId: SafeId<"workspace">) =>
          workspaceIds.includes(workspaceId),
        safeDb: asTestRaw<SafeDb>(
          createSafeDb(testDb, workspaceIds, organizationId, userId),
        ),
        scopedDb: asTestRaw<ScopedDb>(
          createScopedDb(testDb, workspaceIds, organizationId, userId),
        ),
        recordAuditEvent: createAuditRecorder({
          organizationId,
          workspaceId: null,
          userId,
          request,
          server: null,
        }),
      });
    },
    readRunThread: async (options) =>
      Result.ok(await readOpenRunChatThread(testDb, options)),
    filing: {
      uploads: {
        organizationFileUsageDb:
          asTestRaw<UploadUserFileDependencies["organizationFileUsageDb"]>(
            testDb,
          ),
      },
    },
  });
  server = serveRoutesForTest(
    routes(
      { "/:runId/browser-downloads": { POST: handler } },
      { prefix: "/v1/chat/local-runs" },
    ),
  );
});

afterAll(async () => {
  await server.stop();
  fake.stop();
  await releaseRlsFixture();
});

describe("a run filing a download its chat's tab made", () => {
  test("lands in the chat's own matter as a document that keeps where it came from, once", async () => {
    const runId = await insertRun(ids.chatThreadWorkspaceA1);
    const token = tokenFor(runId, [ids.wsA1]);
    const before = await documentsIn(ids.wsA1);

    const filed = await filedOf(await post(runId, token));

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

    // The same bytes again, under another name and from another run of the
    // chat: the matter's document is named, and nothing new is stored.
    const againRun = await insertRun(ids.chatThreadWorkspaceA1);
    const again = await filedOf(
      await post(againRun, tokenFor(againRun, [ids.wsA1]), {
        name: "Decision 1 (final).pdf",
        pageUrl: null,
      }),
    );
    expect(again).toEqual({ ...filed, duplicate: true });
    expect(await documentsIn(ids.wsA1)).toBe(before + 1);
  });

  test("the same new file filed twice at once makes one document, and both name it", async () => {
    const bytes = await largeScannedPdf({ minBytes: 4096, text: "Annex 7" });
    const first = await insertRun(ids.chatThreadWorkspaceA1);
    const second = await insertRun(ids.chatThreadWorkspaceA1);
    const before = await documentsIn(ids.wsA1);

    const filed = await Promise.all(
      [first, second].map(
        async (runId) =>
          await filedOf(
            await post(runId, tokenFor(runId, [ids.wsA1]), { bytes }),
          ),
      ),
    );

    expect(await documentsIn(ids.wsA1)).toBe(before + 1);
    // One filing made the document; the other names it.
    const [made, named] = filed.toSorted((a, b) =>
      a.type === "document" && b.type === "document"
        ? Number(a.duplicate) - Number(b.duplicate)
        : 0,
    );
    expect(made).toMatchObject({ duplicate: false, type: "document" });
    expect(named).toMatchObject({ duplicate: true, type: "document" });
    expect(named).toMatchObject({
      entityId: made?.type === "document" ? made.entityId : "",
    });
  });

  test("a signed address is kept without its credentials, query or fragment", async () => {
    const runId = await insertRun(ids.chatThreadWorkspaceA1);
    const bytes = await largeScannedPdf({ minBytes: 2048, text: "Signed 3" });

    const filed = await filedOf(
      await post(runId, tokenFor(runId, [ids.wsA1]), {
        bytes,
        pageUrl: "https://fixture-library.test/doc/3?session=s1#top",
        sourceUrl:
          "https://member:secret@files.fixture-library.test/doc/3.pdf?X-Signature=abc",
      }),
    );

    if (filed.type !== "document") {
      throw new Error("Expected a document");
    }
    const versions = await testDb
      .select({ source: entityVersions.source })
      .from(entityVersions)
      .where(eq(entityVersions.entityId, toSafeId<"entity">(filed.entityId)));
    expect(versions).toMatchObject([
      {
        source: {
          kind: "browser-download",
          pageUrl: "https://fixture-library.test/doc/3",
          sourceUrl: "https://files.fixture-library.test/doc/3.pdf",
        },
      },
    ]);
  });

  test("a chat in no matter keeps the file with the chat", async () => {
    const runId = await insertRun(ids.chatThreadGlobalA1);
    const before = await documentsIn(ids.wsA1);

    const filed = await filedOf(await post(runId, tokenFor(runId, [ids.wsA1])));

    expect(filed.type).toBe("chat_file");
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

  test("a matter the run's token does not reach is refused, never swapped for another", async () => {
    const runId = await insertRun(ids.chatThreadWorkspaceA1);
    const beforeA1 = await documentsIn(ids.wsA1);
    const beforeA2 = await documentsIn(ids.wsA2);

    const refused = await post(runId, tokenFor(runId, [ids.wsA2]));

    expect(refused.status).toBe(404);
    expect(await documentsIn(ids.wsA1)).toBe(beforeA1);
    expect(await documentsIn(ids.wsA2)).toBe(beforeA2);
  });

  test("a file that is not a PDF is refused with its reason, and nothing is stored", async () => {
    const runId = await insertRun(ids.chatThreadWorkspaceA1);
    const before = await documentsIn(ids.wsA1);

    const refused = await post(runId, tokenFor(runId, [ids.wsA1]), {
      bytes: new TextEncoder().encode("<html>Not a PDF</html>"),
      name: "Decision 1.pdf",
    });

    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      code: BROWSER_DOWNLOAD_REFUSAL_CODE.notPdf,
    });
    expect(await documentsIn(ids.wsA1)).toBe(before);
  });

  test("a request without the run's token, or with another run's, files nothing", async () => {
    const runId = await insertRun(ids.chatThreadWorkspaceA1);
    const otherRun = await insertRun(ids.chatThreadWorkspaceA1);
    const before = await documentsIn(ids.wsA1);

    const withoutToken = await fetch(
      new URL(localRunBrowserDownloadPath(runId), server.url),
      { method: "POST", body: new FormData() },
    );
    expect(withoutToken.status).toBe(401);
    const otherRunsToken = await post(runId, tokenFor(otherRun, [ids.wsA1]), {
      bytes: await largeScannedPdf({ minBytes: 2048, text: "Never filed" }),
    });
    expect(otherRunsToken.status).toBe(403);
    expect(await documentsIn(ids.wsA1)).toBe(before);
  });
});
