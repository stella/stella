import { expect, test } from "bun:test";

import { loadDefaultNativeBinding } from "../native-runtime";

test("Bun validates the requested WASM binding version", async () => {
  let failure: unknown;
  try {
    await loadDefaultNativeBinding({
      expectedVersion: "0.0.0-test-mismatch",
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) {
    throw new Error("version mismatch did not produce an Error");
  }
  expect(failure.message).toContain("does not match 0.0.0-test-mismatch");
});
