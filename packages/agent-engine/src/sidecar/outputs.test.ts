import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type DesktopRunnerOutputEvent,
  desktopRunnerOutputPath,
} from "@stll/api-contract/desktop-runner";

import {
  MAX_REPORTED_UNSHARED_OUTPUTS,
  MAX_RUN_OUTPUT_FILES,
  OutputUploadFailed,
  runOutputUploader,
  shareOutputs,
  snapshotOutputs,
  type UploadOutput,
} from "./outputs";

const FILE_ID = "019a0000-0000-7000-8000-000000000001";

type Uploaded = { name: string; text: string };

/** An API that keeps what it is sent and answers every file with `FILE_ID`. */
const recording = () => {
  const uploaded: Uploaded[] = [];
  const upload: UploadOutput = async (file) => {
    uploaded.push({ name: file.name, text: await file.text() });
    return Result.ok(FILE_ID);
  };
  return { uploaded, upload };
};

const collect = async (
  reports: AsyncIterable<DesktopRunnerOutputEvent>,
): Promise<DesktopRunnerOutputEvent[]> => await Array.fromAsync(reports);

describe("sharing what a turn wrote to its outputs folder", () => {
  let workspace = "";
  let outputs = "";
  let outside = "";
  const signal = new AbortController().signal;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "outputs-workspace-"));
    outside = await mkdtemp(path.join(tmpdir(), "outputs-outside-"));
    outputs = path.join(workspace, "outputs");
    await mkdir(outputs);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  test("uploads only what is new or changed since the run started", async () => {
    await writeFile(path.join(outputs, "kept.txt"), "from an earlier turn");
    await writeFile(path.join(outputs, "edited.txt"), "before");
    const before = await snapshotOutputs(workspace);

    await writeFile(path.join(outputs, "edited.txt"), "after the turn");
    await writeFile(path.join(outputs, "new.txt"), "written this turn");
    const { uploaded, upload } = recording();
    const reports = await collect(
      shareOutputs({ workspaceDir: workspace, before, upload, signal }),
    );

    expect(uploaded).toEqual([
      { name: "edited.txt", text: "after the turn" },
      { name: "new.txt", text: "written this turn" },
    ]);
    expect(reports).toEqual([
      { status: "uploaded", fileId: FILE_ID, fileName: "edited.txt" },
      { status: "uploaded", fileId: FILE_ID, fileName: "new.txt" },
    ]);
  });

  test("a later turn does not share a file an earlier turn already wrote", async () => {
    await writeFile(path.join(outputs, "report.txt"), "first turn");
    const secondTurnStart = await snapshotOutputs(workspace);
    const { uploaded, upload } = recording();
    const reports = await collect(
      shareOutputs({
        workspaceDir: workspace,
        before: secondTurnStart,
        upload,
        signal,
      }),
    );
    expect(uploaded).toEqual([]);
    expect(reports).toEqual([]);
  });

  test("a file rewritten with the same size is shared by its new time", async () => {
    const report = path.join(outputs, "report.txt");
    await writeFile(report, "aaaa");
    await utimes(report, 1000, 1000);
    const before = await snapshotOutputs(workspace);
    await writeFile(report, "bbbb");
    await utimes(report, 2000, 2000);
    const { uploaded, upload } = recording();
    await collect(
      shareOutputs({ workspaceDir: workspace, before, upload, signal }),
    );
    expect(uploaded).toEqual([{ name: "report.txt", text: "bbbb" }]);
  });

  test("shares from nested folders under the file's own name", async () => {
    const before = await snapshotOutputs(workspace);
    await mkdir(path.join(outputs, "drafts", "v2"), { recursive: true });
    await writeFile(path.join(outputs, "drafts", "v2", "nda.md"), "# NDA");
    const { uploaded, upload } = recording();
    await collect(
      shareOutputs({ workspaceDir: workspace, before, upload, signal }),
    );
    expect(uploaded).toEqual([{ name: "nda.md", text: "# NDA" }]);
  });

  test("files outside the folder never leave the computer", async () => {
    const before = await snapshotOutputs(workspace);
    await writeFile(path.join(workspace, "scratch.txt"), "working notes");
    await mkdir(path.join(workspace, ".cache"));
    await writeFile(path.join(workspace, ".cache", "blob"), "cache");
    const { uploaded, upload } = recording();
    const reports = await collect(
      shareOutputs({ workspaceDir: workspace, before, upload, signal }),
    );
    expect(uploaded).toEqual([]);
    expect(reports).toEqual([]);
  });

  test("a link planted as a file is refused, and what it names is not read", async () => {
    const secret = path.join(outside, "secret.txt");
    await writeFile(secret, "outside the sandbox");
    const before = await snapshotOutputs(workspace);
    await symlink(secret, path.join(outputs, "report.txt"));
    const { uploaded, upload } = recording();
    const reports = await collect(
      shareOutputs({ workspaceDir: workspace, before, upload, signal }),
    );
    expect(uploaded).toEqual([]);
    expect(reports).toEqual([{ status: "failed", fileName: "report.txt" }]);
  });

  test("a link planted as a folder is not walked", async () => {
    await writeFile(path.join(outside, "secret.txt"), "outside the sandbox");
    const before = await snapshotOutputs(workspace);
    await symlink(outside, path.join(outputs, "drafts"));
    const { uploaded, upload } = recording();
    const reports = await collect(
      shareOutputs({ workspaceDir: workspace, before, upload, signal }),
    );
    expect(uploaded).toEqual([]);
    expect(reports).toEqual([{ status: "failed", fileName: "drafts" }]);
  });

  test("an outputs folder that is itself a link shares nothing", async () => {
    await writeFile(path.join(outside, "secret.txt"), "outside the sandbox");
    await rm(outputs, { recursive: true });
    const before = await snapshotOutputs(workspace);
    await symlink(outside, outputs);
    const { uploaded, upload } = recording();
    const reports = await collect(
      shareOutputs({ workspaceDir: workspace, before, upload, signal }),
    );
    expect(uploaded).toEqual([]);
    expect(reports).toEqual([]);
  });

  test("a file swapped for a link between the scan and the read is refused", async () => {
    const secret = path.join(outside, "secret.txt");
    await writeFile(secret, "outside the sandbox");
    const report = path.join(outputs, "report.txt");
    const first = path.join(outputs, "a.txt");
    const before = await snapshotOutputs(workspace);
    await writeFile(first, "first");
    await writeFile(report, "second");
    const uploaded: string[] = [];
    // Uploading the first file gives the agent's window: the second is
    // replaced after the scan listed it as a regular file.
    const upload: UploadOutput = async (file) => {
      uploaded.push(file.name);
      await rm(report);
      await symlink(secret, report);
      return Result.ok(FILE_ID);
    };
    const reports = await collect(
      shareOutputs({ workspaceDir: workspace, before, upload, signal }),
    );
    expect(uploaded).toEqual(["a.txt"]);
    expect(reports).toEqual([
      { status: "uploaded", fileId: FILE_ID, fileName: "a.txt" },
      { status: "failed", fileName: "report.txt" },
    ]);
  });

  test("a folder swapped for a link between the scan and the read is refused", async () => {
    const secret = path.join(outside, "report.txt");
    await writeFile(secret, "outside the sandbox");
    const drafts = path.join(outputs, "drafts");
    await mkdir(drafts);
    const before = await snapshotOutputs(workspace);
    await writeFile(path.join(outputs, "a.txt"), "first");
    await writeFile(path.join(drafts, "report.txt"), "second");
    const uploaded: string[] = [];
    const upload: UploadOutput = async (file) => {
      uploaded.push(file.name);
      await rm(drafts, { recursive: true });
      await symlink(outside, drafts);
      return Result.ok(FILE_ID);
    };
    const reports = await collect(
      shareOutputs({ workspaceDir: workspace, before, upload, signal }),
    );
    expect(uploaded).toEqual(["a.txt"]);
    expect(reports.at(-1)).toEqual({
      status: "failed",
      fileName: "report.txt",
    });
  });

  test("a hard link to a file the agent could reach is an ordinary file", async () => {
    // A hard link needs write access to the original already, so it reveals
    // nothing the agent could not read itself; pinned so the rule stays known.
    const original = path.join(workspace, "draft.txt");
    await writeFile(original, "draft");
    const before = await snapshotOutputs(workspace);
    await link(original, path.join(outputs, "draft.txt"));
    const { uploaded, upload } = recording();
    await collect(
      shareOutputs({ workspaceDir: workspace, before, upload, signal }),
    );
    expect(uploaded).toEqual([{ name: "draft.txt", text: "draft" }]);
  });

  test("a file over the size cap stays and is reported without being read", async () => {
    const before = await snapshotOutputs(workspace);
    const huge = path.join(outputs, "huge.txt");
    await writeFile(huge, "");
    await truncate(huge, 50 * 1024 * 1024 + 1);
    const { uploaded, upload } = recording();
    const reports = await collect(
      shareOutputs({ workspaceDir: workspace, before, upload, signal }),
    );
    expect(uploaded).toEqual([]);
    expect(reports).toEqual([{ status: "failed", fileName: "huge.txt" }]);
  });

  test("files past the count cap stay, and only so many of them are named", async () => {
    const before = await snapshotOutputs(workspace);
    const total = MAX_RUN_OUTPUT_FILES + MAX_REPORTED_UNSHARED_OUTPUTS + 5;
    await Promise.all(
      Array.from({ length: total }, async (_, index) => {
        const name = `file-${String(index).padStart(4, "0")}.txt`;
        await writeFile(path.join(outputs, name), name);
      }),
    );
    const { uploaded, upload } = recording();
    const reports = await collect(
      shareOutputs({ workspaceDir: workspace, before, upload, signal }),
    );
    expect(uploaded).toHaveLength(MAX_RUN_OUTPUT_FILES);
    expect(reports.filter(({ status }) => status === "uploaded")).toHaveLength(
      MAX_RUN_OUTPUT_FILES,
    );
    expect(reports.filter(({ status }) => status === "failed")).toHaveLength(
      MAX_REPORTED_UNSHARED_OUTPUTS,
    );
  });

  test("an upload that fails reports that file and goes on with the next", async () => {
    const before = await snapshotOutputs(workspace);
    await writeFile(path.join(outputs, "a.txt"), "a");
    await writeFile(path.join(outputs, "b.txt"), "b");
    await writeFile(path.join(outputs, "c.txt"), "c");
    const upload: UploadOutput = async (file) => {
      if (file.name === "a.txt") {
        throw new Error("the line dropped");
      }
      return await Promise.resolve(
        file.name === "b.txt"
          ? Result.err(new OutputUploadFailed({ message: "refused" }))
          : Result.ok(FILE_ID),
      );
    };
    const reports = await collect(
      shareOutputs({ workspaceDir: workspace, before, upload, signal }),
    );
    expect(reports).toEqual([
      { status: "failed", fileName: "a.txt" },
      { status: "failed", fileName: "b.txt" },
      { status: "uploaded", fileId: FILE_ID, fileName: "c.txt" },
    ]);
  });

  test("a stopped run uploads nothing more and reports what is left", async () => {
    const before = await snapshotOutputs(workspace);
    await writeFile(path.join(outputs, "a.txt"), "a");
    await writeFile(path.join(outputs, "b.txt"), "b");
    const stopped = new AbortController();
    const uploaded: string[] = [];
    const upload: UploadOutput = async (file) => {
      uploaded.push(file.name);
      stopped.abort();
      return await Promise.resolve(Result.ok(FILE_ID));
    };
    const reports = await collect(
      shareOutputs({
        workspaceDir: workspace,
        before,
        upload,
        signal: stopped.signal,
      }),
    );
    expect(uploaded).toEqual(["a.txt"]);
    expect(reports.at(-1)).toEqual({ status: "failed", fileName: "b.txt" });
  });

  test("a run that wrote no outputs folder shares nothing", async () => {
    await rm(outputs, { recursive: true });
    const before = await snapshotOutputs(workspace);
    const { uploaded, upload } = recording();
    expect(
      await collect(
        shareOutputs({ workspaceDir: workspace, before, upload, signal }),
      ),
    ).toEqual([]);
    expect(uploaded).toEqual([]);
  });
});

describe("posting a run's file to the API", () => {
  const RUN_ID = "019a0000-0000-7000-8000-00000000000a";
  const servers: { stop: (force: boolean) => unknown }[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.stop(true);
    }
  });

  const serving = (answer: (request: Request) => Promise<Response>) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: answer,
    });
    servers.push(server);
    return `http://127.0.0.1:${String(server.port)}`;
  };
  const file = () => new File(["hello"], "report.txt");
  const never = new AbortController().signal;

  test("sends the file to the run's path with the run's current token", async () => {
    const seen: { url: string; authorization: string | null; body: string }[] =
      [];
    const apiOrigin = serving(async (request) => {
      seen.push({
        url: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      });
      return Response.json({ fileId: FILE_ID });
    });
    let token = "first";
    const upload = runOutputUploader({
      apiOrigin,
      runId: RUN_ID,
      token: () => token,
    });
    token = "refreshed";
    expect((await upload(file(), never)).unwrap()).toBe(FILE_ID);
    expect(seen).toEqual([
      {
        url: desktopRunnerOutputPath(RUN_ID),
        authorization: "Bearer refreshed",
        body: expect.stringContaining('filename="report.txt"'),
      },
    ]);
    expect(seen.at(0)?.body).toContain('name="file"');
    expect(seen.at(0)?.body).toContain("hello");
  });

  test("a redirect is not followed, so the token stays on the API", async () => {
    let elsewhere = 0;
    const other = serving(async () => {
      elsewhere += 1;
      return await Promise.resolve(Response.json({ fileId: FILE_ID }));
    });
    const apiOrigin = serving(
      async () =>
        await Promise.resolve(
          new Response(null, {
            status: 307,
            headers: { location: `${other}/stolen` },
          }),
        ),
    );
    const upload = runOutputUploader({
      apiOrigin,
      runId: RUN_ID,
      token: () => "token",
    });
    expect(Result.isError(await upload(file(), never))).toBe(true);
    expect(elsewhere).toBe(0);
  });

  test("a refusal and an answer that names no file are failures", async () => {
    const refused = serving(
      async () => await Promise.resolve(new Response(null, { status: 422 })),
    );
    const malformed = serving(
      async () =>
        await Promise.resolve(Response.json({ fileId: "not-a-file-id" })),
    );
    for (const apiOrigin of [refused, malformed]) {
      const upload = runOutputUploader({
        apiOrigin,
        runId: RUN_ID,
        token: () => "token",
      });
      // await-in-loop: each origin answers its own request.
      expect(Result.isError(await upload(file(), never))).toBe(true);
    }
  });

  test("a run without a token sends nothing", async () => {
    let requests = 0;
    const apiOrigin = serving(async () => {
      requests += 1;
      return await Promise.resolve(Response.json({ fileId: FILE_ID }));
    });
    const upload = runOutputUploader({
      apiOrigin,
      runId: RUN_ID,
      token: () => null,
    });
    expect(Result.isError(await upload(file(), never))).toBe(true);
    expect(requests).toBe(0);
  });
});
