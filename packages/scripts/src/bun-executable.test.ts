import { describe, expect, test } from "bun:test";

import { bunExecutable, bunxCommand } from "./bun-executable";

const withBunVersion = (version: string | undefined, assertion: () => void) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");

  Object.defineProperty(process.versions, "bun", {
    configurable: true,
    enumerable: true,
    value: version,
  });

  try {
    assertion();
  } finally {
    if (descriptor === undefined) {
      Reflect.deleteProperty(process.versions, "bun");
    } else {
      Object.defineProperty(process.versions, "bun", descriptor);
    }
  }
};

describe("Bun child process commands", () => {
  test("reuse the running executable under Bun", () => {
    withBunVersion("1.4.3", () => {
      expect(bunExecutable()).toBe(process.execPath);
      expect(bunxCommand(["tsx", "fixture.ts"])).toEqual([
        process.execPath,
        "x",
        "tsx",
        "fixture.ts",
      ]);
    });
  });

  test("resolve Bun from PATH under Node", () => {
    withBunVersion(undefined, () => {
      expect(bunExecutable()).toBe("bun");
      expect(bunxCommand(["tsx", "fixture.ts"])).toEqual([
        "bunx",
        "tsx",
        "fixture.ts",
      ]);
    });
  });
});
