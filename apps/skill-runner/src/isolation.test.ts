import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkCredentialIsolation, sweepNewProcesses } from "./isolation";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/** A process table on disk, laid out as Linux's `/proc` is. */
const procTable = async (
  processes: Record<number, { environ?: string; stat?: string }>,
) => {
  const root = await mkdtemp(path.join(tmpdir(), "proc-"));
  roots.push(root);
  await mkdir(path.join(root, "self"));
  for (const [pid, files] of Object.entries(processes)) {
    await mkdir(path.join(root, pid));
    for (const [name, text] of Object.entries(files)) {
      await writeFile(path.join(root, pid, name), text);
    }
  }
  return root;
};

const running = (pid: number) => `${pid} (sh (x)) S 1 1 1`;

describe("credential isolation", () => {
  test("passes when no readable process holds credentials", async () => {
    const root = await procTable({
      1: { environ: "PATH=/usr/bin\0AWS_REGION=eu-central-1\0" },
      7: { environ: "HOME=/tmp\0" },
    });
    expect((await checkCredentialIsolation(root)).isOk()).toBe(true);
  });

  test("names every readable process that holds credentials", async () => {
    const root = await procTable({
      1: { environ: "PATH=/usr/bin\0AWS_SESSION_TOKEN=token\0" },
      7: { environ: "AWS_SECRET_ACCESS_KEY=secret\0" },
      9: { environ: "NOT_AWS_SECRET_ACCESS_KEY=x\0" },
    });
    const checked = await checkCredentialIsolation(root);
    expect(checked.isErr() && checked.error.message).toBe(
      "AWS credentials are readable in processes 1, 7",
    );
  });

  // Root reads any file whatever its mode, so the case needs another user.
  test.skipIf(process.getuid?.() === 0)(
    "a process whose environment cannot be read is out of a command's reach too",
    async () => {
      const root = await procTable({
        1: { environ: "AWS_SECRET_ACCESS_KEY=secret\0" },
      });
      await chmod(path.join(root, "1", "environ"), 0o000);
      expect((await checkCredentialIsolation(root)).isOk()).toBe(true);
    },
  );

  test("fails closed when the process table cannot be read", async () => {
    const checked = await checkCredentialIsolation(
      path.join(tmpdir(), "no-such-proc-table"),
    );
    expect(checked.isErr()).toBe(true);
  });
});

describe("the sweep after a command", () => {
  test("kills only the running processes that appeared during the command", async () => {
    const root = await procTable({
      1: { stat: running(1) },
      2: { stat: running(2) },
      3: { stat: running(3) },
      4: { stat: "4 (sh) Z 1 1 1" },
      [process.pid]: { stat: running(process.pid) },
    });
    const killed: number[] = [];
    const swept = await sweepNewProcesses({
      procRoot: root,
      baseline: new Set([1, 2]),
      kill: (pid) => {
        killed.push(pid);
        rmSync(path.join(root, String(pid)), { recursive: true });
        return true;
      },
    });
    expect(swept.isOk()).toBe(true);
    expect(killed).toEqual([3]);
  });

  test("fails the run when what the command started will not die", async () => {
    const root = await procTable({ 3: { stat: running(3) } });
    const swept = await sweepNewProcesses({
      procRoot: root,
      baseline: new Set(),
      kill: () => false,
    });
    expect(swept.isErr() && swept.error.message).toBe(
      "Processes the command started are still running",
    );
  });
});
