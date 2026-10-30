import { describe, expect, test } from "bun:test";

import {
  ONBOARDING_NAVIGATION,
  ONBOARDING_STEPS,
} from "../src/onboarding/onboarding-types";
import { readNativeSource, rustEnumVariants } from "./rust-enum";

const NATIVE_ONBOARDING = readNativeSource("onboarding.rs");

describe("native onboarding contract", () => {
  test("steps match the native enum in flow order", () => {
    expect(rustEnumVariants(NATIVE_ONBOARDING, "Step")).toEqual([
      ...ONBOARDING_STEPS,
    ]);
  });

  test("every navigation input is a native input", () => {
    expect(rustEnumVariants(NATIVE_ONBOARDING, "Input")).toEqual(
      expect.arrayContaining([...ONBOARDING_NAVIGATION]),
    );
  });
});
