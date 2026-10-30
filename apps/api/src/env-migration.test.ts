import { panic } from "better-result";
import { expect, test } from "bun:test";

import { parseMigrationDrainConfirmation } from "./env-migration";

test("manual drain admission requires an explicit non-empty bounded reason", () => {
  expect(parseMigrationDrainConfirmation(undefined).unwrap()).toEqual({
    type: "automatic",
  });
  const manual = parseMigrationDrainConfirmation(
    "  Isolated maintenance after scheduler drain  ",
  ).unwrap();
  if (manual.type !== "manual") {
    panic("Expected a typed manual drain confirmation");
  }
  const { reason: confirmedReason, ...state } = manual;
  expect(state).toEqual({ type: "manual" });
  expect(String(confirmedReason)).toBe(
    "Isolated maintenance after scheduler drain",
  );
  for (const reason of ["", "   ", "x".repeat(1001)]) {
    const result = parseMigrationDrainConfirmation(reason);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("requires a non-empty reason");
    }
  }
});
