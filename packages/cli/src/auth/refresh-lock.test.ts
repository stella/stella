import { Result } from "better-result";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { acquireRefreshLock } from "./refresh-lock.js";

test("refresh locks restrict permissions and serialize contenders until release", async () => {
  const configDir = await mkdtemp(
    path.join(os.tmpdir(), "stella-refresh-lock-"),
  );
  try {
    const first = await acquireRefreshLock(configDir);
    expect(Result.isOk(first)).toBe(true);
    if (Result.isError(first)) {
      return;
    }
    const lockPath = path.join(configDir, "credentials.store.lock");
    expect((await stat(lockPath)).mode % 0o1000).toBe(0o600);
    expect(await readFile(lockPath, "utf-8")).toBe(`${process.pid}\n`);
    let acquired = false;
    const pending = acquireRefreshLock(configDir).then((result) => {
      acquired = Result.isOk(result);
      return result;
    });
    // real-time: exercise the real filesystem lock polling interval before releasing its owner.
    await Bun.sleep(100);
    expect(acquired).toBe(false);
    await first.value();
    const second = await pending;
    expect(Result.isOk(second)).toBe(true);
    if (Result.isOk(second)) {
      await second.value();
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

// timeout: the abandoned-owner path deliberately exercises the production fifteen-second lock deadline.
test("abandoned refresh locks fail within a bound and permit explicit recovery", async () => {
  const configDir = await mkdtemp(
    path.join(os.tmpdir(), "stella-refresh-lock-"),
  );
  const lockPath = path.join(configDir, "credentials.store.lock");
  try {
    await writeFile(lockPath, "abandoned-owner\n", { mode: 0o600 });
    const result = await acquireRefreshLock(configDir);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toContain("Timed out waiting");
      expect(result.error.message).toContain("remove this lock and retry");
    }
    expect(await readFile(lockPath, "utf-8")).toBe("abandoned-owner\n");
    await rm(lockPath);
    const recovered = await acquireRefreshLock(configDir);
    expect(Result.isOk(recovered)).toBe(true);
    if (Result.isOk(recovered)) {
      await recovered.value();
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}, 20_000);
