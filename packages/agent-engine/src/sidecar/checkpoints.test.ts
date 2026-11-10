import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { waitFor } from "@stll/test-kit";

import {
  captureCheckpoint,
  CHECKPOINT_LIMITS,
  type CheckpointLimits,
  checkpointStoreOf,
  type CheckpointUnavailableReason,
  lockAt,
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

/** What captures and restores logged; nothing here fails a cleanup. */
const logged: string[] = [];
const logLine = (line: string) => {
  logged.push(line);
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
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
    log: logLine,
  });
  return { runId, report };
};

const restore = async (workspaceDir: string, runId: string) =>
  await restoreCheckpoint({ workspaceDir, runId, log: logLine });

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
        ["a manifest's bytes", { maxManifestBytes: 200 }, "too_large"],
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
      // Asked again (an answer that was lost): the same answer, nothing moves.
      write(workspaceDir, "a.txt", "changed since the undo");
      expect((await restore(workspaceDir, second)).outcome).toBe("restored");
      expect(readFileSync(path.join(workspaceDir, "a.txt"), "utf-8")).toBe(
        "changed since the undo",
      );
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
      // Undone already: answered again without touching the folder.
      expect((await restore(workspaceDir, first)).outcome).toBe("restored");
      expect(readFileSync(path.join(workspaceDir, "a.txt"), "utf-8")).toBe(
        "three",
      );
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

  describe.skipIf(isWindows || isRoot)("a restore that fails", () => {
    const store = (workspaceDir: string) => checkpointStoreOf(workspaceDir);
    const recoveries = (workspaceDir: string) =>
      readdirSync(path.join(store(workspaceDir), "recovery"));
    const cleanupModes: (() => void)[] = [];
    /** The checkpoint can no longer be marked undone: the restore must roll back. */
    const lockManifests = (workspaceDir: string) => {
      chmodSync(path.join(store(workspaceDir), "manifests"), 0o500);
      cleanupModes.push(() => {
        chmodSync(path.join(store(workspaceDir), "manifests"), 0o700);
      });
    };
    afterEach(() => {
      for (const reset of cleanupModes.splice(0)) {
        reset();
      }
    });

    test("a member's read-only folder is written and closed again", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "b-ro/doc.txt", "saved");
      chmodSync(path.join(workspaceDir, "b-ro"), 0o555);
      cleanupModes.push(() => {
        chmodSync(path.join(workspaceDir, "b-ro"), 0o755);
      });
      const before = treeOf(workspaceDir);
      const { runId } = await capture(workspaceDir);
      chmodSync(path.join(workspaceDir, "b-ro"), 0o755);
      write(workspaceDir, "b-ro/doc.txt", "changed by the turn");
      write(workspaceDir, "b-ro/new.txt", "created by the turn");
      chmodSync(path.join(workspaceDir, "b-ro"), 0o555);
      expect((await restore(workspaceDir, runId)).outcome).toBe("restored");
      expect(treeOf(workspaceDir)).toEqual(before);
      expect(recoveries(workspaceDir)).toEqual([]);
    });

    test("a restore that cannot be recorded is rolled back exactly, and what it saved first is dropped", async () => {
      const { workspaceDir } = place();
      // Saved: a folder the member closed, holding the old file.
      write(workspaceDir, "d/f.txt", "old");
      chmodSync(path.join(workspaceDir, "d"), 0o500);
      cleanupModes.push(() => {
        chmodSync(path.join(workspaceDir, "d"), 0o700);
      });
      const { runId } = await capture(workspaceDir);
      // The turn opened it and wrote a new file.
      chmodSync(path.join(workspaceDir, "d"), 0o700);
      write(workspaceDir, "d/f.txt", "new");
      write(workspaceDir, "z-created.txt", "created by the turn");
      const saved = treeOf(workspaceDir);
      lockManifests(workspaceDir);

      // The restore writes the old file and closes the folder, then cannot
      // mark the checkpoint: the rollback opens the folder again.
      expect(await restore(workspaceDir, runId)).toEqual({
        outcome: "failed",
        detail: "the restore failed and the folder was put back",
      });
      expect(treeOf(workspaceDir)).toEqual(saved);
      expect(recoveries(workspaceDir)).toEqual([]);
      expect(storedContents(workspaceDir)).not.toContain("new");

      // Not marked undone: it is still the one to restore.
      chmodSync(path.join(store(workspaceDir), "manifests"), 0o700);
      expect((await restore(workspaceDir, runId)).outcome).toBe("restored");
      expect(readFileSync(path.join(workspaceDir, "d/f.txt"), "utf-8")).toBe(
        "old",
      );
    });

    test("a rollback that fails keeps the state before the restore until it can be put back", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "d/f.txt", "old");
      const { runId } = await capture(workspaceDir);
      write(workspaceDir, "d/f.txt", "new");
      lockManifests(workspaceDir);
      const pipe = path.join(workspaceDir, "pipe");

      const restored = await restoreCheckpoint({
        workspaceDir,
        runId,
        log: logLine,
        // Something the rollback cannot save appears before it runs.
        beforeRollback: () => {
          expect(Bun.spawnSync(["mkfifo", pipe]).exitCode).toBe(0);
        },
      });
      expect(restored).toEqual({
        outcome: "failed",
        detail:
          "the restore failed and the folder could not be put back; the state before was kept",
      });
      const kept = recoveries(workspaceDir);
      expect(kept).toHaveLength(1);
      const recovery: unknown = JSON.parse(
        readFileSync(
          path.join(store(workspaceDir), "recovery", kept[0] ?? ""),
          "utf-8",
        ),
      );
      expect(recovery).toMatchObject({
        restoreOf: runId,
        entries: expect.arrayContaining([
          expect.objectContaining({ kind: "file", path: "d/f.txt" }),
        ]),
      });
      expect(storedContents(workspaceDir)).toContain("new");

      // While it cannot be put back, nothing else runs on the store.
      chmodSync(path.join(store(workspaceDir), "manifests"), 0o700);
      expect((await capture(workspaceDir)).report).toEqual({
        status: "unavailable",
        reason: "failed",
      });
      expect(logged.splice(0)).toEqual([
        "an interrupted restore was not settled: The folder holds a special file.",
      ]);
      expect(await restore(workspaceDir, runId)).toEqual({
        outcome: "failed",
        detail: "an interrupted restore could not be settled",
      });
      expect(recoveries(workspaceDir)).toEqual(kept);
      expect(storedContents(workspaceDir)).toContain("new");

      // Once it can, the next capture puts it back first.
      rmSync(pipe);
      expect((await capture(workspaceDir)).report).toEqual({
        status: "taken",
      });
      expect(readFileSync(path.join(workspaceDir, "d/f.txt"), "utf-8")).toBe(
        "new",
      );
      expect(recoveries(workspaceDir)).toEqual([]);
    });

    test("a restore interrupted half way is settled before the next capture", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "d/f.txt", "old");
      const { runId } = await capture(workspaceDir);
      write(workspaceDir, "d/f.txt", "new");
      write(workspaceDir, "z-created.txt", "created by the turn");
      const saved = treeOf(workspaceDir);
      lockManifests(workspaceDir);

      // The holder stops after the restore wrote its record and the folder.
      const interrupted = await restoreCheckpoint({
        workspaceDir,
        runId,
        log: logLine,
        beforeRollback: () => {
          throw new Error("the holder stopped");
        },
      });
      expect(interrupted.outcome).toBe("failed");
      expect(recoveries(workspaceDir)).toHaveLength(1);
      expect(treeOf(workspaceDir)).not.toEqual(saved);

      chmodSync(path.join(store(workspaceDir), "manifests"), 0o700);
      expect((await capture(workspaceDir)).report).toEqual({
        status: "taken",
      });
      expect(treeOf(workspaceDir)).toEqual(saved);
      expect(recoveries(workspaceDir)).toEqual([]);
    });

    test("a restore stopped after it committed keeps the restored folder", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "d/f.txt", "old");
      const { runId } = await capture(workspaceDir);
      write(workspaceDir, "d/f.txt", "new");
      write(workspaceDir, "z-created.txt", "created by the turn");

      // The holder stops right after the checkpoint is marked undone.
      const stopped = await restoreCheckpoint({
        workspaceDir,
        runId,
        log: logLine,
        afterMark: () => {
          throw new Error("the holder stopped");
        },
      });
      expect(stopped.outcome).toBe("failed");
      expect(recoveries(workspaceDir)).toHaveLength(1);
      const restored = treeOf(workspaceDir);
      expect(readFileSync(path.join(workspaceDir, "d/f.txt"), "utf-8")).toBe(
        "old",
      );

      expect((await capture(workspaceDir)).report).toEqual({
        status: "taken",
      });
      expect(treeOf(workspaceDir)).toEqual(restored);
      expect(recoveries(workspaceDir)).toEqual([]);
      // Undone once, and asking again moves nothing.
      expect((await restore(workspaceDir, runId)).outcome).toBe("restored");
      expect(treeOf(workspaceDir)).toEqual(restored);
    });

    test("a restore whose record could not be dropped keeps the restored folder", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "d/f.txt", "old");
      const { runId } = await capture(workspaceDir);
      write(workspaceDir, "d/f.txt", "new");
      const recoveryFolder = path.join(store(workspaceDir), "recovery");

      const restored = await restoreCheckpoint({
        workspaceDir,
        runId,
        log: logLine,
        afterMark: () => {
          chmodSync(recoveryFolder, 0o500);
          cleanupModes.push(() => {
            chmodSync(recoveryFolder, 0o700);
          });
        },
      });
      expect(restored).toEqual({
        outcome: "restored",
        detail: "the state before the restore was kept",
      });
      expect(recoveries(workspaceDir)).toHaveLength(1);
      const after = treeOf(workspaceDir);

      chmodSync(recoveryFolder, 0o700);
      expect((await capture(workspaceDir)).report).toEqual({
        status: "taken",
      });
      expect(treeOf(workspaceDir)).toEqual(after);
      expect(readFileSync(path.join(workspaceDir, "d/f.txt"), "utf-8")).toBe(
        "old",
      );
      expect(recoveries(workspaceDir)).toEqual([]);
    });

    /** A restore that stops after it wrote the folder, as a crash would. */
    const interruptedRestore = async (workspaceDir: string, runId: string) => {
      lockManifests(workspaceDir);
      const interrupted = await restoreCheckpoint({
        workspaceDir,
        runId,
        log: logLine,
        beforeRollback: () => {
          throw new Error("the holder stopped");
        },
      });
      expect(interrupted.outcome).toBe("failed");
      chmodSync(path.join(store(workspaceDir), "manifests"), 0o700);
    };

    test("a restore stopped between removing a folder and writing the file in its place is put back", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "p", "a file before the turn");
      const { runId } = await capture(workspaceDir);
      rmSync(path.join(workspaceDir, "p"));
      write(workspaceDir, "p/x.txt", "the turn made p a folder");
      const saved = treeOf(workspaceDir);
      await interruptedRestore(workspaceDir, runId);
      // Where the restore stopped: the folder removed, the file not written.
      rmSync(path.join(workspaceDir, "p"));

      expect((await capture(workspaceDir)).report).toEqual({
        status: "taken",
      });
      expect(treeOf(workspaceDir)).toEqual(saved);
      expect(recoveries(workspaceDir)).toEqual([]);
    });

    test("a restore stopped between removing a file and making the folder in its place is put back", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "p/y.txt", "in a folder before the turn");
      const { runId } = await capture(workspaceDir);
      rmSync(path.join(workspaceDir, "p"), { recursive: true });
      write(workspaceDir, "p", "the turn made p a file");
      const saved = treeOf(workspaceDir);
      await interruptedRestore(workspaceDir, runId);
      // Where the restore stopped: the file removed, the folder not made.
      rmSync(path.join(workspaceDir, "p"), { recursive: true });

      expect((await capture(workspaceDir)).report).toEqual({
        status: "taken",
      });
      expect(treeOf(workspaceDir)).toEqual(saved);
      expect(recoveries(workspaceDir)).toEqual([]);
    });

    test("a temp file left by a write the restore did not finish is removed", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "d/f.txt", "old");
      const { runId } = await capture(workspaceDir);
      write(workspaceDir, "d/f.txt", "new");
      const saved = treeOf(workspaceDir);
      await interruptedRestore(workspaceDir, runId);
      write(
        workspaceDir,
        `d/.stella-restore-${crypto.randomUUID()}`,
        "half written",
      );

      expect((await capture(workspaceDir)).report).toEqual({
        status: "taken",
      });
      expect(treeOf(workspaceDir)).toEqual(saved);
    });

    test("settling an interrupted restore keeps what changed since, attachments included", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "d/f.txt", "old");
      write(workspaceDir, "notes.txt", "the member's notes");
      const { runId } = await capture(workspaceDir);
      write(workspaceDir, "d/f.txt", "new");
      write(workspaceDir, "z-created.txt", "created by the turn");
      lockManifests(workspaceDir);
      const interrupted = await restoreCheckpoint({
        workspaceDir,
        runId,
        log: logLine,
        beforeRollback: () => {
          throw new Error("the holder stopped");
        },
      });
      expect(interrupted.outcome).toBe("failed");

      // Changed after the interruption: an edit, and a newly copied file.
      const annex =
        "attachments/019a0000-0000-7000-8000-000000000003/annex.pdf";
      write(workspaceDir, "notes.txt", "edited after the interruption");
      write(workspaceDir, annex, "copied for the next run");

      chmodSync(path.join(store(workspaceDir), "manifests"), 0o700);
      expect((await capture(workspaceDir)).report).toEqual({
        status: "taken",
      });
      expect(logged.splice(0)).toEqual([
        "a rollback left entries changed since the restore as they are",
      ]);
      // What the restore wrote is undone; what changed since stays.
      expect(readFileSync(path.join(workspaceDir, "d/f.txt"), "utf-8")).toBe(
        "new",
      );
      expect(
        readFileSync(path.join(workspaceDir, "z-created.txt"), "utf-8"),
      ).toBe("created by the turn");
      expect(readFileSync(path.join(workspaceDir, "notes.txt"), "utf-8")).toBe(
        "edited after the interruption",
      );
      expect(readFileSync(path.join(workspaceDir, annex), "utf-8")).toBe(
        "copied for the next run",
      );
      expect(recoveries(workspaceDir)).toEqual([]);
    });

    test("the store's lock is kept fresh while a restore runs", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "a.txt", "old");
      const { runId } = await capture(workspaceDir);
      write(workspaceDir, "a.txt", "new");
      lockManifests(workspaceDir);
      const lock = path.join(store(workspaceDir), ".lock");
      const refreshed: boolean[] = [];
      const restored = await restoreCheckpoint({
        workspaceDir,
        runId,
        log: logLine,
        limits: { ...CHECKPOINT_LIMITS, lockHeartbeatMs: 20 },
        beforeRollback: async () => {
          const first = statSync(lock).mtimeMs;
          refreshed.push(
            await waitFor(
              () => (statSync(lock).mtimeMs > first ? true : undefined),
              { description: "the lock to be refreshed" },
            ),
          );
        },
      });
      expect(restored.outcome).toBe("failed");
      expect(refreshed).toEqual([true]);
      expect(existsSync(lock)).toBe(false);
    });
  });

  describe("one store at a time", () => {
    const lockFile = (workspaceDir: string) =>
      path.join(checkpointStoreOf(workspaceDir), ".lock");

    test("captures of one folder at once leave every kept checkpoint whole", async () => {
      const { workspaceDir } = place();
      for (const index of [1, 2, 3, 4, 5, 6]) {
        write(
          workspaceDir,
          `case-${String(index)}.txt`,
          `case ${String(index)}`,
        );
      }
      const reports = await Promise.all(
        [1, 2, 3, 4].map(async (turn) => {
          write(
            workspaceDir,
            `turn-${String(turn)}.txt`,
            `turn ${String(turn)}`,
          );
          return (await capture(workspaceDir, { limits: { maxManifests: 2 } }))
            .report;
        }),
      );
      expect(reports).toEqual(
        Array.from({ length: 4 }, () => ({ status: "taken" })),
      );
      const manifests = path.join(checkpointStoreOf(workspaceDir), "manifests");
      const names = readdirSync(manifests);
      expect(names).toHaveLength(2);
      const contents = new Set(storedContents(workspaceDir));
      for (const name of names) {
        const manifest = v.parse(
          v.object({
            entries: v.array(
              v.looseObject({ kind: v.string(), path: v.string() }),
            ),
          }),
          JSON.parse(readFileSync(path.join(manifests, name), "utf-8")),
        );
        for (const entry of manifest.entries) {
          if (entry.kind === "file") {
            expect(
              contents.has(
                readFileSync(path.join(workspaceDir, entry.path), "utf-8"),
              ),
            ).toBe(true);
          }
        }
      }
      expect(existsSync(lockFile(workspaceDir))).toBe(false);
    });

    const holder = (pid: number) =>
      JSON.stringify({ pid, token: crypto.randomUUID() });

    test("a store another live process holds is not used; one whose holder is gone is taken over", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "a.txt", "saved");
      await capture(workspaceDir);
      writeFileSync(lockFile(workspaceDir), holder(process.pid));
      expect(
        (await capture(workspaceDir, { limits: { lockWaitMs: 100 } })).report,
      ).toEqual({ status: "unavailable", reason: "failed" });
      expect(manifestIds(workspaceDir)).toHaveLength(1);

      const gone = Bun.spawn(["true"]);
      await gone.exited;
      writeFileSync(lockFile(workspaceDir), holder(gone.pid));
      expect(
        (await capture(workspaceDir, { limits: { lockWaitMs: 100 } })).report,
      ).toEqual({ status: "taken" });
      expect(manifestIds(workspaceDir)).toHaveLength(2);
      expect(existsSync(lockFile(workspaceDir))).toBe(false);
    });

    test("a lock its holder gives up while another reads it reads as held or as free, never as a failure", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "a.txt", "saved");
      await capture(workspaceDir);
      const file = lockFile(workspaceDir);
      const held = { pid: process.pid, token: crypto.randomUUID() };
      // A holder gives its lock up at any moment; a waiting holder that reads
      // the lock right then must read it as held or free. Reading a name
      // checked a moment before failed the capture of the one who read it.
      // Given up before the name is opened: no lock holds it.
      expect(await lockAt(file)).toEqual(Result.ok(null));
      // Given up after the name is opened: the read is of the lock it held.
      writeFileSync(file, JSON.stringify(held));
      const read = await lockAt(file, async () => {
        rmSync(file);
        await Promise.resolve();
      });
      expect(read).toEqual(Result.ok(held));
      expect(existsSync(file)).toBe(false);
    });

    test.skipIf(isWindows)(
      "two holders taking over one stale lock at once never both hold it",
      async () => {
        const { root, workspaceDir } = place();
        // A second name for the same folder: its work is not queued behind
        // the first in this process, so only the lock file keeps them apart.
        symlinkSync(path.join(root, "agent-runs"), path.join(root, "alias"));
        const alias = path.join(root, "alias", path.basename(workspaceDir));
        write(workspaceDir, "a.txt", "saved");
        await capture(workspaceDir);
        for (const round of [1, 2, 3, 4, 5]) {
          writeFileSync(lockFile(workspaceDir), holder(process.pid));
          utimesSync(lockFile(workspaceDir), 1, 1);
          write(workspaceDir, "a.txt", `round ${String(round)}`);
          // await-in-loop: each round races on a freshly planted stale lock.
          const captures = await Promise.all([
            capture(workspaceDir),
            capture(alias),
          ]);
          expect(captures.map(({ report }) => report)).toEqual([
            { status: "taken" },
            { status: "taken" },
          ]);
        }
        const manifests = path.join(
          checkpointStoreOf(workspaceDir),
          "manifests",
        );
        const ordinals = readdirSync(manifests).map(
          (name) =>
            v.parse(
              v.object({ ordinal: v.number() }),
              JSON.parse(readFileSync(path.join(manifests, name), "utf-8")),
            ).ordinal,
        );
        // Two holders at once would have read the same latest checkpoint.
        expect(new Set(ordinals).size).toBe(ordinals.length);
        expect(ordinals.length).toBe(11);
        expect(
          readdirSync(checkpointStoreOf(workspaceDir)).filter((name) =>
            name.startsWith(".lock"),
          ),
        ).toEqual([]);
      },
    );

    test("a lock its holder stopped refreshing is taken over, even under a live process id", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "a.txt", "saved");
      await capture(workspaceDir);
      // A reused process id: alive, but the lock went unrefreshed for long.
      writeFileSync(lockFile(workspaceDir), holder(process.pid));
      utimesSync(lockFile(workspaceDir), 1, 1);
      expect(
        (await capture(workspaceDir, { limits: { lockWaitMs: 100 } })).report,
      ).toEqual({ status: "taken" });
      expect(existsSync(lockFile(workspaceDir))).toBe(false);
      expect(
        readdirSync(checkpointStoreOf(workspaceDir)).filter((name) =>
          name.startsWith(".lock"),
        ),
      ).toEqual([]);
    });
  });

  describe("reading the store", () => {
    test.skipIf(isWindows || isRoot)(
      "a manifest that cannot be read stops the capture and removes nothing",
      async () => {
        const { workspaceDir } = place();
        write(workspaceDir, "a.txt", "version 1");
        const { runId: first } = await capture(workspaceDir);
        write(workspaceDir, "a.txt", "version 2");
        const { runId: second } = await capture(workspaceDir);
        const unreadable = path.join(
          checkpointStoreOf(workspaceDir),
          "manifests",
          `${first}.json`,
        );
        chmodSync(unreadable, 0o000);
        try {
          write(workspaceDir, "a.txt", "version 3");
          expect(
            (await capture(workspaceDir, { limits: { maxManifests: 1 } }))
              .report,
          ).toEqual({ status: "unavailable", reason: "failed" });
          expect(logged.splice(0)).toEqual([
            "older checkpoints were kept: The checkpoints could not be read.",
          ]);
          expect(manifestIds(workspaceDir)).toEqual([first, second].toSorted());
          expect(storedContents(workspaceDir).toSorted()).toEqual([
            "version 1",
            "version 2",
          ]);
          expect((await restore(workspaceDir, second)).outcome).toBe("failed");
        } finally {
          chmodSync(unreadable, 0o600);
        }
      },
    );

    test("a manifest whose content is not one is dropped", async () => {
      const { workspaceDir } = place();
      write(workspaceDir, "a.txt", "saved");
      const { runId } = await capture(workspaceDir);
      const manifests = path.join(checkpointStoreOf(workspaceDir), "manifests");
      writeFileSync(path.join(manifests, "torn.json"), '{"version":1,"run');
      write(workspaceDir, "a.txt", "changed");
      const { runId: next } = await capture(workspaceDir);
      expect(manifestIds(workspaceDir)).toEqual([runId, next].toSorted());
    });
  });
});
