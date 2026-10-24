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

import { waitForExternalState } from "@stll/property-testing/external-state";

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
    const generated = await withGenerationLock({
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
    generated.unwrap("Fixture generation failed");
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
    await Promise.all(children.map(async (child) => child.exited));
    rmSync(directory, { recursive: true, force: true });
  };
  return { directory, spawn, cleanup };
};

const waitFor = async (filename: string) => {
  await waitForExternalState({
    description: `a worker publishes ${filename}`,
    read: () => existsSync(filename),
  });
};

test("independent generation processes never overlap", async () => {
  const { directory, spawn, cleanup } = fixture();
  try {
    const children = Array.from({ length: 4 }, () => spawn());
    const exits = await Promise.all(
      children.map(async (child) => child.exited),
    );
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
    const failed = await withGenerationLock({
      lockPath,
      run: () => {
        throw failure;
      },
    });
    expect(failed.isErr()).toBe(true);
    if (failed.isErr()) {
      expect(failed.error.cause).toBe(failure);
    }
    let completed = false;
    const generated = await withGenerationLock({
      lockPath,
      run: () => {
        completed = true;
      },
    });
    expect(generated.isOk()).toBe(true);
    expect(completed).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid lock files return errors without running generation", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "stella-invalid-lock-"));
  const lockPath = path.join(directory, "lock.sqlite");
  writeFileSync(lockPath, "invalid SQLite bytes");
  let executions = 0;
  try {
    const failed = await withGenerationLock({
      lockPath,
      run: () => {
        executions += 1;
      },
    });
    expect(failed.isErr()).toBe(true);
    if (failed.isErr()) {
      expect(failed.error.cause).toBeInstanceOf(Error);
    }
    expect(executions).toBe(0);
    rmSync(lockPath);
    const repaired = await withGenerationLock({
      lockPath,
      run: () => {
        executions += 1;
      },
    });
    expect(repaired.isOk()).toBe(true);
    expect(executions).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
