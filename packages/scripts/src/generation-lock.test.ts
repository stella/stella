import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { withGenerationLock } from "./generation-lock";

const fixture = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "stella-generation-lock-"));
  const script = path.join(directory, "worker.ts");
  writeFileSync(
    script,
    `
    import { withGenerationLock } from ${JSON.stringify(path.join(import.meta.dir, "generation-lock.ts"))};
    import { appendFileSync, closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
    const directory = ${JSON.stringify(directory)};
    writeFileSync(directory + '/attempt-' + process.pid, '');
    await withGenerationLock({
      lockPath: directory + '/lock.sqlite',
      run: async () => {
        writeFileSync(directory + '/acquired-' + process.pid, '');
        if (process.argv.includes('--hold')) await Bun.stdin.text();
        const descriptor = openSync(directory + '/active', 'wx');
        appendFileSync(directory + '/events', 'enter\\n');
        await Bun.sleep(150);
        appendFileSync(directory + '/events', 'exit\\n');
        closeSync(descriptor);
        unlinkSync(directory + '/active');
      },
    });
  `,
  );
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const spawn = (...args: string[]) => {
    const child = Bun.spawn([process.execPath, script, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    return child;
  };
  const cleanup = async () => {
    for (const child of children) {
      child.kill();
    }
    await Promise.all(children.map((child) => child.exited));
    rmSync(directory, { recursive: true, force: true });
  };
  return { directory, spawn, cleanup };
};

const waitFor = async (filename: string) => {
  const deadline = performance.now() + 5000;
  while (!existsSync(filename)) {
    if (performance.now() > deadline) {
      throw new Error(`Worker did not publish ${filename}`);
    }
    await Bun.sleep(10);
  }
};

test("independent generation processes never overlap", async () => {
  const { directory, spawn, cleanup } = fixture();
  try {
    const children = Array.from({ length: 4 }, () => spawn());
    const exits = await Promise.all(children.map((child) => child.exited));
    expect(exits).toEqual([0, 0, 0, 0]);
    expect(readFileSync(path.join(directory, "events"), "utf-8")).toBe(
      "enter\nexit\n".repeat(4),
    );
  } finally {
    await cleanup();
  }
});

test("a killed generator releases the lock for a waiting process", async () => {
  const { directory, spawn, cleanup } = fixture();
  try {
    const holder = spawn("--hold");
    await waitFor(path.join(directory, `acquired-${holder.pid}`));
    const waiter = spawn();
    await waitFor(path.join(directory, `attempt-${waiter.pid}`));
    holder.kill("SIGKILL");
    await holder.exited;
    expect(await waiter.exited).toBe(0);
    expect(readFileSync(path.join(directory, "events"), "utf-8")).toBe(
      "enter\nexit\n",
    );
  } finally {
    await cleanup();
  }
});

test("generation failure propagates and releases the lock", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "stella-generation-failure-"),
  );
  const lockPath = path.join(directory, "lock.sqlite");
  try {
    const failure = new Error("generation failed");
    expect(
      await rejectionOf(
        withGenerationLock({
          lockPath,
          run: () => {
            throw failure;
          },
        }),
      ),
    ).toBe(failure);
    let completed = false;
    await withGenerationLock({
      lockPath,
      run: () => {
        completed = true;
      },
    });
    expect(completed).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
