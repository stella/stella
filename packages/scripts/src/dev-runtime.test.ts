import { describe, expect, test } from "bun:test";

import { isPidAlive, parseOwnerPid, stackShutdownReason } from "./dev-runtime";

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
