import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  clearDeferredE2eCleanup,
  E2E_CLEANUP_TARGET_TYPE,
  type E2eCleanupTarget,
  readDeferredE2eCleanup,
  registerDeferredE2eCleanup,
} from "../helpers/deferred-cleanup";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("deferred E2E cleanup", () => {
  test("preserves concurrent worker registrations until global teardown", async () => {
    const outputDirectory = await mkdtemp(
      path.join(tmpdir(), "stella-e2e-cleanup-"),
    );
    temporaryDirectories.push(outputDirectory);
    const targets = [
      {
        type: E2E_CLEANUP_TARGET_TYPE.WORKSPACE,
        id: randomUUID(),
      },
      {
        type: E2E_CLEANUP_TARGET_TYPE.CONTACT,
        id: randomUUID(),
      },
    ] satisfies E2eCleanupTarget[];

    await Promise.all(
      targets.map(async (target) => {
        await registerDeferredE2eCleanup(outputDirectory, target);
      }),
    );

    const registered = await readDeferredE2eCleanup(outputDirectory);
    expect(registered.failures).toEqual([]);
    expect(
      registered.targets.toSorted((left, right) =>
        left.type.localeCompare(right.type),
      ),
    ).toEqual(
      targets.toSorted((left, right) => left.type.localeCompare(right.type)),
    );

    await clearDeferredE2eCleanup(outputDirectory);
    expect(await readDeferredE2eCleanup(outputDirectory)).toEqual({
      failures: [],
      targets: [],
    });
  });

  test("retains valid targets when a registry record is malformed", async () => {
    const outputDirectory = await mkdtemp(
      path.join(tmpdir(), "stella-e2e-cleanup-"),
    );
    temporaryDirectories.push(outputDirectory);
    const target = {
      type: E2E_CLEANUP_TARGET_TYPE.WORKSPACE,
      id: randomUUID(),
    } satisfies E2eCleanupTarget;
    await registerDeferredE2eCleanup(outputDirectory, target);
    const cleanupDirectory = path.join(outputDirectory, "route-smoke-cleanup");
    await mkdir(cleanupDirectory, { recursive: true });
    await writeFile(path.join(cleanupDirectory, "malformed.json"), "{");

    const result = await readDeferredE2eCleanup(outputDirectory);

    expect(result.targets).toEqual([target]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures.at(0)).toMatchObject({
      message: "Invalid deferred E2E cleanup target: malformed.json",
    });
  });
});
