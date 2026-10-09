import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEV_STATE_DIR,
  isPidAlive,
  parseOwnerPid,
  readDevRuntime,
  stackShutdownReason,
} from "./dev-runtime";

describe("stackShutdownReason", () => {
  test("keeps a stack whose checkout exists and whose owner lives or is unnamed", () => {
    expect(
      stackShutdownReason({ checkoutExists: true, ownerAlive: true }),
    ).toBeNull();
    expect(
      stackShutdownReason({ checkoutExists: true, ownerAlive: null }),
    ).toBeNull();
  });

  test("stops a stack whose owner is gone", () => {
    expect(
      stackShutdownReason({ checkoutExists: true, ownerAlive: false }),
    ).toBe("owner-exited");
  });

  test("stops a stack whose checkout was removed, whatever its owner does", () => {
    for (const ownerAlive of [true, false, null]) {
      expect(stackShutdownReason({ checkoutExists: false, ownerAlive })).toBe(
        "checkout-removed",
      );
    }
  });
});

describe("owner pid", () => {
  test("parses only real process ids", () => {
    expect(parseOwnerPid("4242")).toBe(4242);
    for (const value of [undefined, "", "abc", "1", "0", "-5", "1.5"]) {
      expect(parseOwnerPid(value)).toBeNull();
    }
  });

  test("sees this process as alive and an unused pid as gone", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 22 + 12_345)).toBe(false);
  });
});

describe("readDevRuntime", () => {
  test("reads a runtime file that predates stack owners as unowned", () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "dev-runtime-"));
    try {
      mkdirSync(path.join(rootDir, DEV_STATE_DIR));
      writeFileSync(
        path.join(rootDir, DEV_STATE_DIR, "runtime.json"),
        JSON.stringify({
          apiUrl: "http://localhost:3001",
          dockerProject: "stella-dev",
          infraOffset: 0,
          mode: "dev",
          pid: 4242,
          seeded: true,
          startedAt: "2026-10-01T00:00:00Z",
          webUrl: "http://localhost:3000",
        }),
      );
      expect(readDevRuntime(rootDir)).toMatchObject({
        ownerPid: null,
        pid: 4242,
      });
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });
});
