import { expect, test } from "bun:test";

import {
  DESKTOP_FEATURE_MINIMUM_VERSIONS,
  releaseVersionIsBelow,
} from "./desktop-release";

test("only plain releases compare, part by part", () => {
  expect(releaseVersionIsBelow("0.9.90", "0.9.91")).toBe(true);
  expect(releaseVersionIsBelow("0.9.91", "0.9.91")).toBe(false);
  expect(releaseVersionIsBelow("0.10.0", "0.9.91")).toBe(false);
  expect(releaseVersionIsBelow("0.9.100", "0.9.91")).toBe(false);
  expect(releaseVersionIsBelow("0.8.99", "0.9.0")).toBe(true);
  // A checkout build and a pre-release are never below.
  expect(releaseVersionIsBelow("0.9.91-rc.1", "0.9.91")).toBe(false);
  expect(releaseVersionIsBelow("0.0.1-dev", "0.9.91")).toBe(false);
});

test("every feature minimum is a plain release", () => {
  for (const minimum of Object.values(DESKTOP_FEATURE_MINIMUM_VERSIONS)) {
    expect(minimum).toMatch(/^\d+\.\d+\.\d+$/u);
  }
});
