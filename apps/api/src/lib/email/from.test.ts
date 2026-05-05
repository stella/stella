import { describe, expect, test } from "bun:test";

import { formatTransactionalEmailFrom } from "./from";

describe("formatTransactionalEmailFrom", () => {
  test("adds the stella sender name to bare addresses", () => {
    expect(formatTransactionalEmailFrom("noreply@example.com")).toBe(
      "stella <noreply@example.com>",
    );
  });

  test("replaces an existing sender name while preserving the address", () => {
    expect(formatTransactionalEmailFrom("Stella <noreply@example.com>")).toBe(
      "stella <noreply@example.com>",
    );
  });
});
