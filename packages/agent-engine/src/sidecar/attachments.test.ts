import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Fetcher } from "@stll/fetch";

import { copyAttachments } from "./attachments";

const FILE_ID = "019a0000-0000-7000-8000-000000000001";
const PATH = `attachments/${FILE_ID}/smlouva o dílo.pdf`;
const URL = "https://files.example/signed";

const answering =
  (body: string, status = 200): Fetcher =>
  async () =>
    await Promise.resolve(new Response(body, { status }));

const refusing: Fetcher = async () =>
  await Promise.reject(new Error("the link must not be read"));

describe("copying a run's attached files", () => {
  let root = "";
  let workspace = "";
  let outside = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "attachments-root-"));
    workspace = path.join(root, "workspace");
    await mkdir(workspace);
    outside = await mkdtemp(path.join(tmpdir(), "attachments-outside-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  test("a file lands at its path, readable only by the member", async () => {
    const copied = await copyAttachments(
      [{ path: PATH, url: URL }],
      workspace,
      {
        fetch: answering("contents"),
      },
    );
    expect(Result.isOk(copied)).toBe(true);
    const target = path.join(workspace, PATH);
    expect(await readFile(target, "utf-8")).toBe("contents");
    expect((await stat(target)).mode % 0o1000).toBe(0o600);
    expect(await readdir(path.dirname(target))).toEqual(["smlouva o dílo.pdf"]);
  });

  test("a file already there keeps what the agent did to it", async () => {
    const target = path.join(workspace, PATH);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "edited by the agent");
    const copied = await copyAttachments(
      [{ path: PATH, url: URL }],
      workspace,
      {
        fetch: refusing,
      },
    );
    expect(Result.isOk(copied)).toBe(true);
    expect(await readFile(target, "utf-8")).toBe("edited by the agent");
  });

  test("a failed link leaves no file, so the next turn copies it again", async () => {
    const failed = await copyAttachments(
      [{ path: PATH, url: URL }],
      workspace,
      {
        fetch: answering("expired", 403),
      },
    );
    expect(Result.isError(failed)).toBe(true);
    expect(await readdir(workspace)).toEqual([]);
    expect(await readdir(root)).toEqual(["workspace"]);
    const retried = await copyAttachments(
      [{ path: PATH, url: URL }],
      workspace,
      {
        fetch: answering("contents"),
      },
    );
    expect(Result.isOk(retried)).toBe(true);
    expect(await readFile(path.join(workspace, PATH), "utf-8")).toBe(
      "contents",
    );
  });

  test("a link the agent planted does not move a copy out of the folder", async () => {
    await symlink(outside, path.join(workspace, "attachments"));
    const copied = await copyAttachments(
      [{ path: PATH, url: URL }],
      workspace,
      {
        fetch: answering("contents"),
      },
    );
    expect(Result.isError(copied)).toBe(true);
    expect(await readdir(outside)).toEqual([]);
  });

  test("a link planted at the file's own place is not followed", async () => {
    const target = path.join(workspace, PATH);
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(path.join(outside, "stolen"), target);
    const copied = await copyAttachments(
      [{ path: PATH, url: URL }],
      workspace,
      {
        fetch: answering("contents"),
      },
    );
    expect(Result.isError(copied)).toBe(true);
    expect(await readdir(outside)).toEqual([]);
  });

  test("a body that fails midway leaves nothing behind", async () => {
    const breaking: Fetcher = async () =>
      await Promise.resolve(
        new Response(
          new ReadableStream({
            pull: (controller) => {
              controller.enqueue(new TextEncoder().encode("half"));
              controller.error(new Error("the line dropped"));
            },
          }),
        ),
      );
    const failed = await copyAttachments(
      [{ path: PATH, url: URL }],
      workspace,
      { fetch: breaking },
    );
    expect(Result.isError(failed)).toBe(true);
    expect(await readdir(root)).toEqual(["workspace"]);
    expect(await readdir(workspace)).toEqual([]);
  });

  test("a stopped run copies nothing", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const copied = await copyAttachments(
      [{ path: PATH, url: URL }],
      workspace,
      { fetch: answering("contents"), signal: stopped.signal },
    );
    expect(Result.isError(copied)).toBe(true);
    expect(await readdir(workspace)).toEqual([]);
  });
});
