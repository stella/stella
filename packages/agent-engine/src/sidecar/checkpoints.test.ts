import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  captureCheckpoint,
  CHECKPOINT_LIMITS,
  type CheckpointLimits,
  checkpointStoreOf,
  type CheckpointUnavailableReason,
  restoreCheckpoint,
} from "./checkpoints";

/**
 * Checkpoints on the real filesystem: a folder is saved, changed the way an
 * agent changes it, and put back. Nothing is mocked.
 *
 * Platforms: links, modes, special files and the failure planted through a
 * read-only folder are POSIX behaviour, so those tests are skipped on
 * Windows; a test that relies on a permission refusal is skipped as root,
 * which no refusal stops. The remaining tests run on every platform CI runs.
 */

const isWindows = process.platform === "win32";
const isRoot = process.getuid?.() === 0;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A run's folder, with its sibling store, and a folder outside both. */
const place = () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-checkpoints-"));
  roots.push(root);
  const workspaceDir = path.join(root, "agent-runs", crypto.randomUUID());
  const outside = path.join(root, "outside");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(outside);
  return { root, workspaceDir, outside };
};

const write = (dir: string, relative: string, content: string) => {
  const target = path.join(dir, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

type TreeEntry =
  | { path: string; kind: "file"; content: string; mode: number }
  | { path: string; kind: "dir"; mode: number }
  | { path: string; kind: "link"; target: string };

/** Every entry under `dir`, never following a link. */
const treeOf = (dir: string, relative = ""): TreeEntry[] =>
  readdirSync(path.join(dir, relative))
    .toSorted()
    .flatMap((name): TreeEntry[] => {
      const entryPath = relative === "" ? name : `${relative}/${name}`;
      const target = path.join(dir, entryPath);
      const stat = lstatSync(target);
      const mode = isWindows ? 0 : stat.mode % 0o1000;
      if (stat.isSymbolicLink()) {
        return [
          { path: entryPath, kind: "link", target: readlinkSync(target) },
        ];
      }
      if (stat.isDirectory()) {
        return [
          { path: entryPath, kind: "dir", mode },
          ...treeOf(dir, entryPath),
        ];
      }
      return [
        {
          path: entryPath,
          kind: "file",
          content: readFileSync(target, "utf-8"),
          mode,
        },
      ];
    });

/** Every stored file's content. */
const storedContents = (workspaceDir: string) => {
  const objects = path.join(checkpointStoreOf(workspaceDir), "objects");
  return readdirSync(objects).flatMap((bucket) =>
    readdirSync(path.join(objects, bucket)).map((name) =>
      readFileSync(path.join(objects, bucket, name), "utf-8"),
    ),
  );
};

const manifestIds = (workspaceDir: string) =>
  readdirSync(path.join(checkpointStoreOf(workspaceDir), "manifests"))
    .map((name) => name.replace(/\.json$/u, ""))
    .toSorted();

type Capture = {
  memberFiles?: string[];
  protectedPaths?: string[];
  limits?: Partial<CheckpointLimits>;
};

/** What captures logged; nothing in these folders fails a cleanup. */
const logged: string[] = [];
afterEach(() => {
  expect(logged.splice(0)).toEqual([]);
});

const capture = async (
  workspaceDir: string,
  { memberFiles = [], protectedPaths = [], limits = {} }: Capture = {},
) => {
  const runId = crypto.randomUUID();
  const report = await captureCheckpoint({
    workspaceDir,
    runId,
    memberFiles,
    protectedPaths,
    limits: { ...CHECKPOINT_LIMITS, ...limits },
    log: (line) => {
      logged.push(line);
    },
  });
  return { runId, report };
};

const restore = async (workspaceDir: string, runId: string) =>
  await restoreCheckpoint({ workspaceDir, runId });

describe("a run folder's checkpoint", () => {
  test("restores what a turn changed, created and deleted, nested folders included", async () => {
    const { workspaceDir } = place();
    write(workspaceDir, "brief.txt", "the first draft");
    write(workspaceDir, "cases/2024/judgment.txt", "the court held");
    write(workspaceDir, "cases/2024/notes/summary.txt", "a summary");
    write(workspaceDir, "outputs/earlier.txt", "an earlier output");
    mkdirSync(path.join(workspaceDir, "empty"));
    const before = treeOf(workspaceDir);
    const { runId, report } = await capture(workspaceDir);
    expect(report).toEqual({ status: "taken" });

    // The turn edits, creates, deletes, and replaces a folder with a file.
    write(workspaceDir, "brief.txt", "rewritten by the agent");
    write(workspaceDir, "outputs/report.txt", "a new output");
    write(workspaceDir, "scratch/a/b/c.txt", "scratch work");
    rmSync(path.join(workspaceDir, "cases/2024/notes"), { recursive: true });
    rmSync(path.join(workspaceDir, "empty"), { recursive: true });
    writeFileSync(path.join(workspaceDir, "empty"), "now a file");
    expect(treeOf(workspaceDir)).not.toEqual(before);

    expect(await restore(workspaceDir, runId)).toEqual({
      outcome: "restored",
      detail: null,
    });
    expect(treeOf(workspaceDir)).toEqual(before);
  });

  test("restores a name whose case the turn changed, under its saved case", async () => {
    const { workspaceDir } = place();
    write(workspaceDir, "Notes.txt", "saved");
    const before = treeOf(workspaceDir);
    const { runId } = await capture(workspaceDir);
    renameSync(
      path.join(workspaceDir, "Notes.txt"),
      path.join(workspaceDir, "notes.txt"),
    );
    write(workspaceDir, "notes.txt", "changed");
    expect((await restore(workspaceDir, runId)).outcome).toBe("restored");
    expect(treeOf(workspaceDir)).toEqual(before);
  });

  test.skipIf(isWindows)("restores modes of files and folders", async () => {
    const { workspaceDir } = place();
    write(workspaceDir, "tool.sh", "#!/bin/sh\n");
    chmodSync(path.join(workspaceDir, "tool.sh"), 0o755);
    write(workspaceDir, "private/key.txt", "member only");
    chmodSync(path.join(workspaceDir, "private"), 0o700);
    const before = treeOf(workspaceDir);
    const { runId } = await capture(workspaceDir);
    chmodSync(path.join(workspaceDir, "tool.sh"), 0o644);
    chmodSync(path.join(workspaceDir, "private"), 0o755);
    expect((await restore(workspaceDir, runId)).outcome).toBe("restored");
    expect(treeOf(workspaceDir)).toEqual(before);
  });

  test("stores an unchanged file once, across files and across checkpoints", async () => {
    const { workspaceDir } = place();
    write(workspaceDir, "a.txt", "same content");
    write(workspaceDir, "copy/a.txt", "same content");
    write(workspaceDir, "b.txt", "other content");
    await capture(workspaceDir);
    await capture(workspaceDir);
    write(workspaceDir, "c.txt", "a third");
    await capture(workspaceDir);
    expect(storedContents(workspaceDir).toSorted()).toEqual([
      "a third",
      "other content",
      "same content",
    ]);
    expect(manifestIds(workspaceDir)).toHaveLength(3);
  });

  test("a file changed in place with its size kept is stored again", async () => {
    const { workspaceDir } = place();
    write(workspaceDir, "a.txt", "version 1");
    const { runId: first } = await capture(workspaceDir);
    write(workspaceDir, "a.txt", "version 2");
    const { runId: second } = await capture(workspaceDir);
    write(workspaceDir, "a.txt", "version 3");
    expect((await restore(workspaceDir, second)).outcome).toBe("restored");
    expect(readFileSync(path.join(workspaceDir, "a.txt"), "utf-8")).toBe(
      "version 2",
    );
    expect((await restore(workspaceDir, first)).outcome).toBe("restored");
    expect(readFileSync(path.join(workspaceDir, "a.txt"), "utf-8")).toBe(
      "version 1",
    );
  });

  test("an empty or missing folder restores to empty", async () => {
    const { workspaceDir } = place();
    rmSync(workspaceDir, { recursive: true });
    const { runId, report } = await capture(workspaceDir);
    expect(report).toEqual({ status: "taken" });
    write(workspaceDir, "created.txt", "by the turn");
    expect((await restore(workspaceDir, runId)).outcome).toBe("restored");
    expect(treeOf(workspaceDir)).toEqual([]);
  });

  describe("bounds", () => {
    const unavailable = (reason: CheckpointUnavailableReason) => ({
      status: "unavailable" as const,
      reason,
    });

    test("past any bound nothing is saved and the reason is reported", async () => {
      const cases: [
        string,
        Partial<CheckpointLimits>,
        CheckpointUnavailableReason,
      ][] = [
        ["entries", { maxEntries: 3 }, "too_large"],
        ["depth", { maxDepth: 1 }, "too_large"],
        ["one file's bytes", { maxFileBytes: 10 }, "too_large"],
        ["a capture's new bytes", { maxNewBytes: 20 }, "too_large"],
        ["time", { maxCaptureMs: 0 }, "too_slow"],
      ];
      for (const [name, limits, reason] of cases) {
        const { workspaceDir } = place();
        write(workspaceDir, "a.txt", "0123456789");
        write(workspaceDir, "b.txt", "0123456789");
        write(workspaceDir, "deep/er/c.txt", "012345678901");
        const { runId, report } = await capture(workspaceDir, { limits });
        expect({ name, report }).toEqual({
          name,
          report: unavailable(reason),
        });
        expect({ name, ids: manifestIds(workspaceDir) }).toEqual({
          name,
          ids: [],
        });
        expect({ name, stored: storedContents(workspaceDir) }).toEqual({
          name,
          stored: [],
        });
        expect((await restore(workspaceDir, runId)).outcome).toBe(
          "no_checkpoint",
        );
      }
    });

    test("within every bound the same folder is saved", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "a.txt", "0123456789");
      write(workspaceDir, "b.txt", "0123456789");
      write(workspaceDir, "deep/er/c.txt", "012345678901");
      const { report } = await capture(workspaceDir, {
        limits: {
          maxEntries: 5,
          maxDepth: 2,
          maxFileBytes: 12,
          maxNewBytes: 32,
        },
      });
      expect(report).toEqual({ status: "taken" });
    });

    test.skipIf(isWindows)(
      "a pipe in the folder is not saved, and is never opened",
      async () => {
        const { workspaceDir } = place();
        const made = Bun.spawnSync(["mkfifo", path.join(workspaceDir, "pipe")]);
        expect(made.exitCode).toBe(0);
        expect((await capture(workspaceDir)).report).toEqual(
          unavailable("unsupported"),
        );
      },
    );

    test("a folder holding a skill folder, the package cache or the CLI home is not saved", async () => {
      const { workspaceDir, outside } = place();
      expect(
        (
          await capture(workspaceDir, {
            protectedPaths: [path.join(workspaceDir, "skills", "drafting")],
          })
        ).report,
      ).toEqual(unavailable("unsupported"));
      expect(
        (
          await capture(workspaceDir, {
            protectedPaths: [path.dirname(workspaceDir)],
          })
        ).report,
      ).toEqual(unavailable("unsupported"));
      expect(
        (await capture(workspaceDir, { protectedPaths: [outside] })).report,
      ).toEqual({ status: "taken" });
    });
  });

  describe("pruning", () => {
    test("keeps the newest checkpoints and only the files they name", async () => {
      const { workspaceDir } = place();
      const ids: string[] = [];
      for (const version of [1, 2, 3, 4, 5]) {
        write(workspaceDir, "a.txt", `version ${String(version)}`);
        // await-in-loop: each checkpoint follows the folder's change.
        ids.push(
          (await capture(workspaceDir, { limits: { maxManifests: 3 } })).runId,
        );
      }
      expect(manifestIds(workspaceDir)).toEqual(ids.slice(2).toSorted());
      expect(storedContents(workspaceDir).toSorted()).toEqual([
        "version 3",
        "version 4",
        "version 5",
      ]);
      expect((await restore(workspaceDir, ids[0] ?? "")).outcome).toBe(
        "no_checkpoint",
      );
    });

    test("drops the oldest past the stored bytes, never the newest", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "a.txt", "x".repeat(40));
      const { runId: first } = await capture(workspaceDir, {
        limits: { maxStoredBytes: 100 },
      });
      write(workspaceDir, "b.txt", "y".repeat(40));
      const { runId: second } = await capture(workspaceDir, {
        limits: { maxStoredBytes: 100 },
      });
      expect(manifestIds(workspaceDir)).toEqual([first, second].toSorted());
      write(workspaceDir, "c.txt", "z".repeat(40));
      const { runId: third } = await capture(workspaceDir, {
        limits: { maxStoredBytes: 100 },
      });
      // Three files of 40 bytes are past 100: the newest alone stays.
      expect(manifestIds(workspaceDir)).toEqual([third]);
      expect(storedContents(workspaceDir)).toHaveLength(3);
      write(workspaceDir, "d.txt", "w".repeat(200));
      const { runId: fourth } = await capture(workspaceDir, {
        limits: { maxStoredBytes: 100 },
      });
      expect(manifestIds(workspaceDir)).toEqual([fourth]);
    });
  });

  describe("which checkpoint may be restored", () => {
    test("only the newest not undone yet, then the one before it", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "a.txt", "before the first turn");
      const { runId: first } = await capture(workspaceDir);
      write(workspaceDir, "a.txt", "before the second turn");
      const { runId: second } = await capture(workspaceDir);
      write(workspaceDir, "a.txt", "after the second turn");

      expect((await restore(workspaceDir, first)).outcome).toBe("not_newest");
      expect(readFileSync(path.join(workspaceDir, "a.txt"), "utf-8")).toBe(
        "after the second turn",
      );
      expect((await restore(workspaceDir, crypto.randomUUID())).outcome).toBe(
        "no_checkpoint",
      );
      expect((await restore(workspaceDir, second)).outcome).toBe("restored");
      // Undone once: never restored again.
      expect((await restore(workspaceDir, second)).outcome).toBe("not_newest");
      expect((await restore(workspaceDir, first)).outcome).toBe("restored");
      expect(readFileSync(path.join(workspaceDir, "a.txt"), "utf-8")).toBe(
        "before the first turn",
      );
    });

    test("a turn after an undo is the newest again", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "a.txt", "one");
      const { runId: first } = await capture(workspaceDir);
      write(workspaceDir, "a.txt", "two");
      expect((await restore(workspaceDir, first)).outcome).toBe("restored");
      const { runId: next } = await capture(workspaceDir);
      write(workspaceDir, "a.txt", "three");
      expect((await restore(workspaceDir, first)).outcome).toBe("not_newest");
      expect((await restore(workspaceDir, next)).outcome).toBe("restored");
      expect(readFileSync(path.join(workspaceDir, "a.txt"), "utf-8")).toBe(
        "one",
      );
    });

    test("a folder with no store has no checkpoint", async () => {
      const { workspaceDir } = place();
      expect(await restore(workspaceDir, crypto.randomUUID())).toEqual({
        outcome: "no_checkpoint",
        detail: null,
      });
    });

    test("a stored file that changed fails the restore before anything moves", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "a.txt", "saved");
      const { runId } = await capture(workspaceDir);
      write(workspaceDir, "a.txt", "changed by the turn");
      const after = treeOf(workspaceDir);
      const objects = path.join(checkpointStoreOf(workspaceDir), "objects");
      for (const bucket of readdirSync(objects)) {
        for (const name of readdirSync(path.join(objects, bucket))) {
          writeFileSync(path.join(objects, bucket, name), "tampered");
        }
      }
      expect((await restore(workspaceDir, runId)).outcome).toBe("failed");
      expect(treeOf(workspaceDir)).toEqual(after);
    });
  });

  describe("attachments", () => {
    const attachment =
      "attachments/019a0000-0000-7000-8000-000000000001/lease.pdf";
    const later = "attachments/019a0000-0000-7000-8000-000000000002/annex.pdf";

    test("an agent's edit to the run's attachment is undone; the attachment stays", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, attachment, "as the member attached it");
      const { runId } = await capture(workspaceDir, {
        memberFiles: [attachment],
      });
      write(workspaceDir, attachment, "edited by the agent");
      expect((await restore(workspaceDir, runId)).outcome).toBe("restored");
      expect(readFileSync(path.join(workspaceDir, attachment), "utf-8")).toBe(
        "as the member attached it",
      );
    });

    test("undoing an earlier turn keeps the attachments of later turns", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "draft.txt", "before the first turn");
      const { runId: first } = await capture(workspaceDir);
      write(workspaceDir, "draft.txt", "after the first turn");
      // The second message attaches a file, copied before its checkpoint.
      write(workspaceDir, later, "the member's annex");
      const { runId: second } = await capture(workspaceDir, {
        memberFiles: [later],
      });
      write(workspaceDir, later, "edited by the agent");
      expect((await restore(workspaceDir, second)).outcome).toBe("restored");
      expect((await restore(workspaceDir, first)).outcome).toBe("restored");
      expect(treeOf(workspaceDir)).toEqual([
        { path: "attachments", kind: "dir", mode: expect.any(Number) },
        {
          path: "attachments/019a0000-0000-7000-8000-000000000002",
          kind: "dir",
          mode: expect.any(Number),
        },
        {
          path: later,
          kind: "file",
          content: "the member's annex",
          mode: expect.any(Number),
        },
        {
          path: "draft.txt",
          kind: "file",
          content: "before the first turn",
          mode: expect.any(Number),
        },
      ]);
    });
  });

  describe.skipIf(isWindows)("links", () => {
    test("a link is saved and restored as a link, never read or written through", async () => {
      const { workspaceDir, outside } = place();
      write(outside, "secret.txt", "outside the folder");
      write(workspaceDir, "notes.txt", "the member's notes");
      symlinkSync(
        path.join(outside, "secret.txt"),
        path.join(workspaceDir, "secret-link"),
      );
      symlinkSync(outside, path.join(workspaceDir, "outside-link"));
      const before = treeOf(workspaceDir);
      const { runId, report } = await capture(workspaceDir);
      expect(report).toEqual({ status: "taken" });
      expect(storedContents(workspaceDir)).toEqual(["the member's notes"]);

      // The turn swaps the notes for a link out, and repoints a link.
      unlinkSync(path.join(workspaceDir, "notes.txt"));
      symlinkSync(
        path.join(outside, "secret.txt"),
        path.join(workspaceDir, "notes.txt"),
      );
      unlinkSync(path.join(workspaceDir, "outside-link"));
      symlinkSync("/", path.join(workspaceDir, "outside-link"));
      expect((await restore(workspaceDir, runId)).outcome).toBe("restored");
      expect(treeOf(workspaceDir)).toEqual(before);
      expect(readFileSync(path.join(outside, "secret.txt"), "utf-8")).toBe(
        "outside the folder",
      );
      expect(treeOf(outside)).toEqual([
        {
          path: "secret.txt",
          kind: "file",
          content: "outside the folder",
          mode: expect.any(Number),
        },
      ]);
    });

    test("a folder the turn replaced with a link out is restored without writing through it", async () => {
      const { workspaceDir, outside } = place();
      write(workspaceDir, "cases/judgment.txt", "the court held");
      const before = treeOf(workspaceDir);
      const { runId } = await capture(workspaceDir);
      rmSync(path.join(workspaceDir, "cases"), { recursive: true });
      symlinkSync(outside, path.join(workspaceDir, "cases"));
      expect((await restore(workspaceDir, runId)).outcome).toBe("restored");
      expect(treeOf(workspaceDir)).toEqual(before);
      expect(treeOf(outside)).toEqual([]);
    });

    test("a skill folder reached through a link is never saved or touched", async () => {
      const { workspaceDir, root } = place();
      const skill = path.join(root, "skills", "drafting");
      write(skill, "SKILL.md", "the skill");
      symlinkSync(skill, path.join(workspaceDir, "drafting"));
      const { runId, report } = await capture(workspaceDir, {
        protectedPaths: [skill],
      });
      expect(report).toEqual({ status: "taken" });
      expect(storedContents(workspaceDir)).toEqual([]);
      // Changed through the link during the turn (its sandbox would refuse).
      write(skill, "SKILL.md", "changed during the turn");
      write(workspaceDir, "draft.txt", "written by the turn");
      expect((await restore(workspaceDir, runId)).outcome).toBe("restored");
      expect(readFileSync(path.join(skill, "SKILL.md"), "utf-8")).toBe(
        "changed during the turn",
      );
      expect(
        lstatSync(path.join(workspaceDir, "drafting")).isSymbolicLink(),
      ).toBe(true);
      expect(
        treeOf(workspaceDir).map(({ path: entryPath }) => entryPath),
      ).toEqual(["drafting"]);
    });
  });

  test.skipIf(isWindows || isRoot)(
    "a failure halfway through puts the folder back exactly as it was before the restore",
    async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "a.txt", "saved");
      // The member's own read-only folder.
      write(workspaceDir, "b-ro/doc.txt", "saved");
      chmodSync(path.join(workspaceDir, "b-ro"), 0o555);
      const { runId } = await capture(workspaceDir);
      try {
        write(workspaceDir, "a.txt", "changed by the turn");
        write(workspaceDir, "z-new.txt", "created by the turn");
        // The turn opened the folder, changed the file and closed it again,
        // so the restore cannot write there: it fails after it already
        // removed `z-new.txt` and wrote `a.txt`.
        chmodSync(path.join(workspaceDir, "b-ro"), 0o755);
        write(workspaceDir, "b-ro/doc.txt", "changed by the turn");
        chmodSync(path.join(workspaceDir, "b-ro"), 0o555);
        const saved = treeOf(workspaceDir);

        const restored = await restore(workspaceDir, runId);
        expect(restored).toEqual({
          outcome: "failed",
          detail: "the restore failed and the folder was put back",
        });
        expect(treeOf(workspaceDir)).toEqual(saved);
        // Not marked undone: it is still the one to restore.
        chmodSync(path.join(workspaceDir, "b-ro"), 0o755);
        expect((await restore(workspaceDir, runId)).outcome).toBe("restored");
        expect(
          readFileSync(path.join(workspaceDir, "b-ro/doc.txt"), "utf-8"),
        ).toBe("saved");
      } finally {
        chmodSync(path.join(workspaceDir, "b-ro"), 0o755);
      }
    },
  );
});
