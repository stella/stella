import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";

import {
  DESKTOP_RUNNER_OUTPUT_MAX_BYTES,
  desktopRunnerOutputPath,
} from "@stll/api-contract/desktop-runner";

import type { SafeDb } from "@/api/db/safe-db";
import { auditLogs, desktopRunnerRuns, userFiles } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { envBase } from "@/api/env-base";
import type { UploadUserFileDependencies } from "@/api/handlers/chat/upload-files";
import { routes } from "@/api/http/route";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { readOpenRunChatThread } from "@/api/lib/desktop-runner/store";
import { AGENT_RUN_TOKEN_PURPOSE } from "@/api/mcp/constants";
import { McpOrganizationAccessError } from "@/api/mcp/errors";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { serveRoutesForTest } from "@/api/tests/helpers/serve-routes";
import type { TestServer } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createUploadRunOutput } from "./upload";

// timeout: each file goes through the real security scan and a fake object store.
setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let fake: FakeS3;
let server: TestServer;

type Claims = {
  sub: string;
  org_id: string;
  run_id?: string;
  purpose?: string;
  scope?: string;
  workspace_ids?: string[];
};

/** Tokens the fake verifier knows; anything else is refused as forged. */
const tokens = new Map<string, Claims>();
/** Members whose access the live check has taken away. */
const revoked = new Set<string>();

const tokenFor = (claims: Partial<Claims> & { run_id: string }) => {
  const token = `token-${Bun.randomUUIDv7()}`;
  tokens.set(token, {
    sub: ids.userA1,
    org_id: ids.orgA,
    purpose: AGENT_RUN_TOKEN_PURPOSE,
    scope: "stella:read stella:chat",
    workspace_ids: [ids.wsA1],
    ...claims,
  });
  return token;
};

const insertRun = async ({
  state = "running",
  threadId,
  userId,
  organizationId,
}: {
  state?: "running" | "finished";
  threadId: string | null;
  userId: string;
  organizationId: SafeId<"organization">;
}) => {
  const runId = Bun.randomUUIDv7();
  await testDb.insert(desktopRunnerRuns).values({
    runId,
    userId,
    organizationId,
    desktopId: Bun.randomUUIDv7(),
    deviceJkt: "jkt",
    harness: "codex",
    harnessVersion: "1.0.0",
    workspaceIds: [],
    state,
    leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    chatThreadId: threadId,
  });
  return runId;
};

const post = async (
  runId: string,
  {
    token,
    file = new File(["hello"], "report.txt"),
  }: { token: string | null; file?: File },
) => {
  const body = new FormData();
  body.set("file", file);
  return await fetch(new URL(desktopRunnerOutputPath(runId), server.url), {
    method: "POST",
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body,
  });
};

const storedRow = async (fileId: string) =>
  (
    await testDb
      .select()
      .from(userFiles)
      .where(eq(userFiles.id, toSafeId<"userFile">(fileId)))
  ).at(0);

const fileIdOf = async (response: Response) => {
  expect(response.status).toBe(200);
  const answer: unknown = await response.json();
  expect(answer).toEqual({ fileId: expect.any(String) });
  return (answer as { fileId: string }).fileId;
};

beforeAll(async () => {
  fake = startFakeS3();
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  const upload = createUploadRunOutput({
    verifyToken: async (token) => {
      const claims = token === undefined ? undefined : tokens.get(token);
      if (claims === undefined) {
        throw new Error("UNAUTHORIZED");
      }
      return await Promise.resolve(claims);
    },
    resolveContext: async (session, { request }) => {
      if (revoked.has(session.userId)) {
        throw new McpOrganizationAccessError({
          message: "The member's access ended",
        });
      }
      const organizationId = toSafeId<"organization">(session.organizationId);
      const userId = toSafeId<"user">(session.userId);
      return await Promise.resolve({
        safeDb: asTestRaw<SafeDb>(
          createSafeDb(
            testDb,
            (session.workspaceIds ?? []).map((id) => toSafeId<"workspace">(id)),
            organizationId,
            userId,
          ),
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
    uploads: {
      organizationFileUsageDb:
        asTestRaw<UploadUserFileDependencies["organizationFileUsageDb"]>(
          testDb,
        ),
    },
  });
  server = serveRoutesForTest(
    routes(
      { "/:runId/outputs": { POST: upload } },
      { prefix: "/v1/chat/local-runs" },
    ),
  );
});

afterAll(async () => {
  await server.stop();
  fake.stop();
  await releaseRlsFixture();
});

describe("a run handing a file back", () => {
  test("stores it in the run's thread, with an audit row and the object", async () => {
    const runId = await insertRun({
      threadId: ids.chatThreadWorkspaceA1,
      userId: ids.userA1,
      organizationId: ids.orgA,
    });
    const fileId = await fileIdOf(
      await post(runId, { token: tokenFor({ run_id: runId }) }),
    );
    const row = await storedRow(fileId);
    expect(row).toMatchObject({
      userId: ids.userA1,
      threadId: ids.chatThreadWorkspaceA1,
      fileName: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    });
    expect(
      fake.objects.get(`${envBase.S3_BUCKET}/${row?.s3Key ?? ""}`)?.contentType,
    ).toBe("text/plain");
    const audit = await testDb
      .select({ resourceId: auditLogs.resourceId })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceId, fileId),
          eq(auditLogs.organizationId, ids.orgA),
        ),
      );
    expect(audit).toHaveLength(1);
  });

  test("a request cannot name a thread: the run's row does", async () => {
    const runId = await insertRun({
      threadId: ids.chatThreadWorkspaceA1,
      userId: ids.userA1,
      organizationId: ids.orgA,
    });
    const body = new FormData();
    body.set("file", new File(["hello"], "report.txt"));
    body.set("threadId", ids.chatThreadWorkspaceB1);
    const refused = await fetch(
      new URL(desktopRunnerOutputPath(runId), server.url),
      {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor({ run_id: runId })}` },
        body,
      },
    );
    // The body is strict: a field it does not read is a refusal, not a hint.
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
  });

  test("allows HTML as a run's output", async () => {
    const runId = await insertRun({
      threadId: ids.chatThreadWorkspaceA1,
      userId: ids.userA1,
      organizationId: ids.orgA,
    });
    const fileId = await fileIdOf(
      await post(runId, {
        token: tokenFor({ run_id: runId }),
        file: new File(
          ["<!doctype html><html><body><h1>Report</h1></body></html>"],
          "report.html",
        ),
      }),
    );
    expect(await storedRow(fileId)).toMatchObject({
      mimeType: "text/html",
      fileName: "report.html",
    });
  });
});

describe("what the endpoint refuses", () => {
  const runOfA1 = async () =>
    await insertRun({
      threadId: ids.chatThreadWorkspaceA1,
      userId: ids.userA1,
      organizationId: ids.orgA,
    });

  test("no token, and a token nobody issued", async () => {
    const runId = await runOfA1();
    expect((await post(runId, { token: null })).status).toBe(401);
    expect((await post(runId, { token: "forged" })).status).toBe(401);
  });

  test("a token of another run of the same member", async () => {
    const runId = await runOfA1();
    const other = await runOfA1();
    expect(
      (await post(runId, { token: tokenFor({ run_id: other }) })).status,
    ).toBe(403);
  });

  test("a member's own OAuth token, which is not a run's", async () => {
    const runId = await runOfA1();
    const token = `token-${Bun.randomUUIDv7()}`;
    tokens.set(token, {
      sub: ids.userA1,
      org_id: ids.orgA,
      scope: "stella:read stella:chat",
    });
    expect((await post(runId, { token })).status).toBeGreaterThanOrEqual(401);
    expect((await post(runId, { token })).status).toBeLessThan(404);
  });

  test("another member's token naming this member's run", async () => {
    const runId = await runOfA1();
    const response = await post(runId, {
      token: tokenFor({
        run_id: runId,
        sub: ids.userB1,
        org_id: ids.orgB,
        workspace_ids: [ids.wsB1],
      }),
    });
    expect(response.status).toBe(404);
  });

  test("the member's token under another organization", async () => {
    const runId = await runOfA1();
    const response = await post(runId, {
      token: tokenFor({ run_id: runId, org_id: ids.orgB }),
    });
    expect(response.status).toBe(404);
  });

  test("a run that already ended", async () => {
    const runId = await insertRun({
      state: "finished",
      threadId: ids.chatThreadWorkspaceA1,
      userId: ids.userA1,
      organizationId: ids.orgA,
    });
    expect(
      (await post(runId, { token: tokenFor({ run_id: runId }) })).status,
    ).toBe(404);
  });

  test("a run no chat started", async () => {
    const runId = await insertRun({
      threadId: null,
      userId: ids.userA1,
      organizationId: ids.orgA,
    });
    expect(
      (await post(runId, { token: tokenFor({ run_id: runId }) })).status,
    ).toBe(404);
  });

  test("a token without the chat scope", async () => {
    const runId = await runOfA1();
    expect(
      (
        await post(runId, {
          token: tokenFor({ run_id: runId, scope: "stella:read" }),
        })
      ).status,
    ).toBe(403);
  });

  test("a member whose access ended", async () => {
    const runId = await runOfA1();
    revoked.add(ids.userA1);
    try {
      expect(
        (await post(runId, { token: tokenFor({ run_id: runId }) })).status,
      ).toBe(403);
    } finally {
      revoked.delete(ids.userA1);
    }
  });

  test("a type no run may hand back, whatever the bytes", async () => {
    const runId = await runOfA1();
    for (const name of ["payload.exe", "icon.svg", "report", "archive.zip"]) {
      // await-in-loop: one request at a time against one run.
      const response = await post(runId, {
        token: tokenFor({ run_id: runId }),
        file: new File(["hello"], name),
      });
      expect(response.status).toBe(422);
    }
  });

  test("bytes that are not what their name says", async () => {
    const runId = await runOfA1();
    const response = await post(runId, {
      token: tokenFor({ run_id: runId }),
      file: new File(["<html>not a pdf</html>"], "report.pdf"),
    });
    expect(response.status).toBe(422);
  });

  test("a file over the size limit, and an empty one", async () => {
    const runId = await runOfA1();
    const tooLarge = await post(runId, {
      token: tokenFor({ run_id: runId }),
      file: new File(
        [new Uint8Array(DESKTOP_RUNNER_OUTPUT_MAX_BYTES + 1)],
        "report.txt",
      ),
    });
    expect(tooLarge.status).toBeGreaterThanOrEqual(400);
    expect(tooLarge.status).toBeLessThan(500);
    const empty = await post(runId, {
      token: tokenFor({ run_id: runId }),
      file: new File([], "report.txt"),
    });
    expect(empty.status).toBeGreaterThanOrEqual(400);
    expect(empty.status).toBeLessThan(500);
  });
});
