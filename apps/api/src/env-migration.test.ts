import { expect, test } from "bun:test";

import { parseMigrationDrainConfirmation } from "./env-migration";

test("manual drain admission requires an explicit non-empty bounded reason", () => {
  expect(parseMigrationDrainConfirmation(undefined).unwrap()).toEqual({
    type: "automatic",
  });
  expect(
    parseMigrationDrainConfirmation(
      "  Isolated maintenance after scheduler drain  ",
    ).unwrap(),
  ).toEqual({
    type: "manual",
    reason: "Isolated maintenance after scheduler drain",
  });
  for (const reason of ["", "   ", "x".repeat(1001)]) {
    const result = parseMigrationDrainConfirmation(reason);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("requires a non-empty reason");
    }
  }
});
