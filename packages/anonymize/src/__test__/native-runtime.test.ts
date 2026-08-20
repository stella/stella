import { expect, test } from "bun:test";

import {
  assertSupportedBunVersion,
  MINIMUM_SUPPORTED_BUN_VERSION,
} from "../bun-version";
import {
  isBunRuntime,
  loadDefaultNativeBinding,
  preloadNativeBinding,
} from "../native-runtime";

test("Bun runtime support starts at 1.4.0", () => {
  expect(MINIMUM_SUPPORTED_BUN_VERSION).toBe("1.4.0");
  expect(() => assertSupportedBunVersion(undefined)).not.toThrow();
  expect(() => assertSupportedBunVersion("1.4.0")).not.toThrow();
  expect(() => assertSupportedBunVersion("1.4.1-rc.1")).not.toThrow();
  expect(() => assertSupportedBunVersion("2.0.0")).not.toThrow();
  expect(() => assertSupportedBunVersion("1.3.9")).toThrow(
    "requires Bun >=1.4.0",
  );
  expect(() => assertSupportedBunVersion("1.4.0-rc.1")).toThrow(
    "requires Bun >=1.4.0",
  );
  expect(() => assertSupportedBunVersion("development")).toThrow(
    "requires Bun >=1.4.0",
  );
});

test("Bun loads the native binding", async () => {
  expect(isBunRuntime()).toBe(true);
  const binding = await loadDefaultNativeBinding();
  expect(binding.nativePackageVersion()).not.toHaveLength(0);
  await preloadNativeBinding();
});

test("native runtime validates the requested binding version", async () => {
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
