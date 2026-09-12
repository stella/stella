import { describe, expect, test } from "bun:test";

import {
  isRegistryReseedableFormat,
  REGISTRY_DEFAULT_FORMAT,
} from "./registry-format-config";

const PREVIOUS_KRS_DEFAULT_FORMAT =
  "[company name] with its registered office at [address], entered in the Register of Entrepreneurs under KRS no. [registry number], kept by Krajowy Rejestr Sądowy, share capital of [share capital], Tax Identification Number (NIP) [NIP], Statistical Identification Number (REGON) [REGON]";

describe("registry default reseeding", () => {
  test("recognizes current built-in formats", () => {
    expect(
      isRegistryReseedableFormat("ares", REGISTRY_DEFAULT_FORMAT.ares),
    ).toBe(true);
  });

  test("recognizes the persisted former KRS default", () => {
    expect(isRegistryReseedableFormat("krs", PREVIOUS_KRS_DEFAULT_FORMAT)).toBe(
      true,
    );
  });

  test("preserves author-edited formats", () => {
    expect(isRegistryReseedableFormat("krs", "custom [company name]")).toBe(
      false,
    );
  });
});
