import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BROWSER_DOWNLOAD_FILE_MAX_BYTES,
  localRunBrowserDownloadPath,
} from "@stll/api-contract/browser-downloads";

import {
  browserDownloadFiler,
  keepLocalInPlan,
} from "./browser-download-filing";

const PDF = "%PDF-1.7\nfixture\n%%EOF\n";
const RUN_ID = "0193a0f4-6b7c-7d8e-9f00-112233445566";
const ORIGIN = {
  downloadedAt: "2026-11-25T09:30:00.000Z",
  pageUrl: "https://fixture-library.test/doc/1",
  sourceUrl: "https://fixture-library.test/doc/1/file",
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

type Received = {
  path: string;
  authorization: string | null;
  fields: Record<string, string>;
  file: { name: string; type: string; text: string } | null;
};

/** A stand-in for stella's API: records each request and answers `answer`. */
const fakeApi = (answer: { status: number; body: unknown }) => {
  const received: Received[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const entries = [...(await request.formData()).entries()];
      const fields = Object.fromEntries(
        entries.flatMap(([key, value]) =>
          typeof value === "string" ? [[key, value]] : [],
        ),
      );
      const sent: unknown = entries
        .map(([, value]) => value as unknown)
        .find((value) => value instanceof File);
      received.push({
        authorization: request.headers.get("authorization"),
        fields,
        file: !(sent instanceof File)
          ? null
          : { name: sent.name, type: sent.type, text: await sent.text() },
        path: new URL(request.url).pathname,
      });
      return Response.json(answer.body, { status: answer.status });
    },
  });
  cleanups.push(async () => {
    await server.stop(true);
  });
  return { origin: `http://127.0.0.1:${String(server.port)}`, received };
};

/** A run's folder with one saved PDF under `Downloads/`. */
const runFolder = (content = PDF) => {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), "stella-filing-"));
  cleanups.push(() => {
    rmSync(workspaceDir, { force: true, recursive: true });
  });
  mkdirSync(path.join(workspaceDir, "Downloads"));
  writeFileSync(
    path.join(workspaceDir, "Downloads", "Decision 1.pdf"),
    content,
  );
  return workspaceDir;
};

const NOT_STOPPED = new AbortController().signal;

const DOCUMENT = {
  duplicate: false,
  entityId: "0193a0f4-6b7c-7d8e-9f00-aabbccddeeff",
  name: "Decision 1.pdf",
  type: "document",
  workspaceId: "0193a0f4-6b7c-7d8e-9f00-001122334455",
} as const;

describe("filing a saved download with stella", () => {
  test("posts the saved copy with where it came from, as the run, and names the matter document", async () => {
    const api = fakeApi({ body: DOCUMENT, status: 200 });
    const file = browserDownloadFiler({
      apiOrigin: api.origin,
      runId: RUN_ID,
      stopped: NOT_STOPPED,
      token: () => "run-token",
      workspaceDir: runFolder(),
    });

    const filed = await file({
      origin: ORIGIN,
      path: "Downloads/Decision 1.pdf",
    });

    expect(filed).toEqual({
      documentId: DOCUMENT.entityId,
      duplicate: false,
      matterId: DOCUMENT.workspaceId,
      name: "Decision 1.pdf",
      status: "document",
    });
    expect(api.received).toEqual([
      {
        authorization: "Bearer run-token",
        fields: {
          downloadedAt: ORIGIN.downloadedAt,
          pageUrl: ORIGIN.pageUrl,
          sourceUrl: ORIGIN.sourceUrl,
        },
        file: { name: "Decision 1.pdf", text: PDF, type: "application/pdf" },
        path: localRunBrowserDownloadPath(RUN_ID),
      },
    ]);
  });

  test("a page that is not known is left out, and a matter that already held the file says so", async () => {
    const api = fakeApi({
      body: { ...DOCUMENT, duplicate: true },
      status: 200,
    });
    const file = browserDownloadFiler({
      apiOrigin: api.origin,
      runId: RUN_ID,
      stopped: NOT_STOPPED,
      token: () => "run-token",
      workspaceDir: runFolder(),
    });

    const filed = await file({
      origin: { ...ORIGIN, pageUrl: null },
      path: "Downloads/Decision 1.pdf",
    });

    expect(filed).toMatchObject({ duplicate: true, status: "document" });
    expect(api.received.at(0)?.fields).not.toHaveProperty("pageUrl");
  });

  test("a chat in no matter keeps the file with the chat", async () => {
    const api = fakeApi({
      body: {
        fileId: "0193a0f4-6b7c-7d8e-9f00-ffeeddccbbaa",
        name: "Decision 1.pdf",
        type: "chat_file",
      },
      status: 200,
    });
    const file = browserDownloadFiler({
      apiOrigin: api.origin,
      runId: RUN_ID,
      stopped: NOT_STOPPED,
      token: () => "run-token",
      workspaceDir: runFolder(),
    });

    expect(
      await file({ origin: ORIGIN, path: "Downloads/Decision 1.pdf" }),
    ).toEqual({
      fileId: "0193a0f4-6b7c-7d8e-9f00-ffeeddccbbaa",
      name: "Decision 1.pdf",
      status: "chat_file",
    });
  });

  test("a refusal is relayed, and the file stays in the run's folder only", async () => {
    const api = fakeApi({
      body: {
        code: "forbidden",
        message: "Matter not found or not accessible",
      },
      status: 404,
    });
    const file = browserDownloadFiler({
      apiOrigin: api.origin,
      runId: RUN_ID,
      stopped: NOT_STOPPED,
      token: () => "run-token",
      workspaceDir: runFolder(),
    });

    expect(
      await file({ origin: ORIGIN, path: "Downloads/Decision 1.pdf" }),
    ).toEqual({
      message:
        "stella did not file it: Matter not found or not accessible. The file is in your working folder only.",
      status: "not_filed",
    });
  });

  test("a run without a token and a file over the limit send nothing", async () => {
    const api = fakeApi({ body: DOCUMENT, status: 200 });
    const workspaceDir = runFolder();
    const withoutToken = browserDownloadFiler({
      apiOrigin: api.origin,
      runId: RUN_ID,
      stopped: NOT_STOPPED,
      token: () => null,
      workspaceDir,
    });
    expect(
      await withoutToken({ origin: ORIGIN, path: "Downloads/Decision 1.pdf" }),
    ).toMatchObject({ status: "not_filed" });

    // Sparse: no disk is used for the size.
    truncateSync(
      path.join(workspaceDir, "Downloads", "Decision 1.pdf"),
      BROWSER_DOWNLOAD_FILE_MAX_BYTES + 1,
    );
    const file = browserDownloadFiler({
      apiOrigin: api.origin,
      runId: RUN_ID,
      stopped: NOT_STOPPED,
      token: () => "run-token",
      workspaceDir,
    });
    expect(
      await file({ origin: ORIGIN, path: "Downloads/Decision 1.pdf" }),
    ).toMatchObject({
      message: expect.stringContaining("the most stella files"),
      status: "not_filed",
    });
    expect(api.received).toEqual([]);
  });

  test("a run in Plan mode files nothing and says so", async () => {
    expect(
      await keepLocalInPlan({
        origin: ORIGIN,
        path: "Downloads/Decision 1.pdf",
      }),
    ).toEqual({
      message:
        "In Plan mode stella files nothing into the matter. The file is in your working folder only.",
      status: "not_filed",
    });
  });

  test("an API that cannot be reached leaves the file local", async () => {
    const file = browserDownloadFiler({
      apiOrigin: "http://127.0.0.1:9",
      runId: RUN_ID,
      stopped: NOT_STOPPED,
      token: () => "run-token",
      workspaceDir: runFolder(),
    });

    expect(
      await file({ origin: ORIGIN, path: "Downloads/Decision 1.pdf" }),
    ).toEqual({
      message:
        "stella could not be reached. The file is in your working folder only.",
      status: "not_filed",
    });
  });
});
