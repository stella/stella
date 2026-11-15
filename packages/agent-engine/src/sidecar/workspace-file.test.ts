import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import {
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  linkGuardOf,
  openInWorkspace,
  readWorkspaceFile,
  removeWorkspaceFile,
  workspaceOpenFlags,
} from "./workspace-file";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

/**
 * A run's folder reached through a link above it, as a system temporary
 * folder is on macOS, and a folder outside it an agent could point a link
 * at. `nested` is a folder two levels below the run's folder.
 */
const folders = () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-workspace-file-"));
  roots.push(root);
  const real = path.join(root, "real");
  const outside = path.join(root, "outside");
  mkdirSync(path.join(real, "chat", "outputs", "drafts"), { recursive: true });
  mkdirSync(outside);
  symlinkSync(real, path.join(root, "linked"));
  const workspaceDir = path.join(root, "linked", "chat");
  const nested = path.join(real, "chat", "outputs", "drafts");
  return { nested, outside, workspaceDir };
};

/** What an agent in the run's folder can do: a folder becomes a link. */
const swapForLink = (folder: string, target: string) => {
  rmSync(folder, { recursive: true });
  symlinkSync(target, folder);
};

const MAX_BYTES = 1024;

describe("a run's folder reached through a link above it", () => {
  test("its files are read", async () => {
    const { nested, workspaceDir } = folders();
    writeFileSync(path.join(nested, "report.txt"), "the report");

    const read = await readWorkspaceFile(
      workspaceDir,
      "outputs/drafts/report.txt",
      MAX_BYTES,
    );

    expect(read).toEqual({
      bytes: new Uint8Array(Buffer.from("the report")),
      type: "read",
    });
  });

  test("a new file is created there, and a file already there is never replaced", async () => {
    const { nested, workspaceDir } = folders();

    const created = await openInWorkspace(
      workspaceDir,
      "outputs/drafts/new.txt",
      "create",
      0o600,
    );
    if (Result.isError(created)) {
      throw new TypeError(`not created: ${created.error.reason}`);
    }
    await created.value.writeFile("written");
    await created.value.close();
    const again = await openInWorkspace(
      workspaceDir,
      "outputs/drafts/new.txt",
      "create",
      0o600,
    );

    expect(readFileSync(path.join(nested, "new.txt"), "utf-8")).toBe("written");
    expect(Result.isError(again) && again.error.reason).toBe("exists");
  });

  test("a file it created is removed while it is still that file", async () => {
    const { nested, workspaceDir } = folders();
    const file = path.join(nested, "partial.pdf");
    writeFileSync(file, "");
    const identity = statSync(file, { bigint: true });

    const removed = await removeWorkspaceFile(
      workspaceDir,
      "outputs/drafts/partial.pdf",
      identity,
    );

    expect(removed).toBe("removed");
    expect(existsSync(file)).toBe(false);
  });
});

describe("a folder below the run's folder swapped for a link", () => {
  test("a read through it is refused as a link", async () => {
    const { nested, outside, workspaceDir } = folders();
    writeFileSync(path.join(outside, "secret.txt"), "outside the run");
    swapForLink(nested, outside);

    const read = await readWorkspaceFile(
      workspaceDir,
      "outputs/drafts/secret.txt",
      MAX_BYTES,
    );

    expect(read).toEqual({ reason: "link", type: "refused" });
  });

  test("a file created through it is refused, and nothing lands outside", async () => {
    const { nested, outside, workspaceDir } = folders();
    swapForLink(nested, outside);

    const created = await openInWorkspace(
      workspaceDir,
      "outputs/drafts/new.txt",
      "create",
      0o600,
    );

    expect(Result.isError(created) && created.error.reason).toBe("link");
    expect(existsSync(path.join(outside, "new.txt"))).toBe(false);
  });

  test("a removal through it leaves the file outside alone", async () => {
    const { nested, outside, workspaceDir } = folders();
    const victim = path.join(outside, "partial.pdf");
    writeFileSync(victim, "the member's file");
    swapForLink(nested, outside);

    // Even asked for the very file outside, the removal does not reach it.
    const removed = await removeWorkspaceFile(
      workspaceDir,
      "outputs/drafts/partial.pdf",
      statSync(victim, { bigint: true }),
    );

    expect(removed).toBe("unreachable");
    expect(readFileSync(victim, "utf-8")).toBe("the member's file");
  });
});

describe("how each platform refuses a link on the way", () => {
  test("only macOS and Linux refuse it at the open itself; every other platform checks first", () => {
    expect(linkGuardOf("darwin")).toBe("no_follow_any");
    expect(linkGuardOf("linux")).toBe("folder_walk");
    expect(linkGuardOf("win32")).toBe("checked_first");
    expect(linkGuardOf("freebsd")).toBe("checked_first");
  });

  test("macOS's no-link-at-any-segment flag is never combined with O_NOFOLLOW, which it refuses", () => {
    const anySegment = 0x20_00_00_00;
    expect(workspaceOpenFlags("read", "no_follow_any")).toBe(
      constants.O_NONBLOCK + anySegment,
    );
    expect(workspaceOpenFlags("create", "no_follow_any")).toBe(
      constants.O_WRONLY + constants.O_CREAT + constants.O_EXCL + anySegment,
    );
    expect(workspaceOpenFlags("read", "folder_walk")).toBe(
      constants.O_NONBLOCK + constants.O_NOFOLLOW,
    );
  });
});
