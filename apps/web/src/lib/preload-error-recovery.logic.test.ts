import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { isStaleDeploymentLoadError } from "./preload-error-recovery";

const PROPERTY_MAX_TEXT_PARTS = 20;
const searchTextArbitrary = fc
  .array(
    fc.constantFrom(
      "a",
      "C",
      "é",
      "e\u0301",
      "Č",
      "c\u030C",
      "ß",
      "ς",
      "😀",
      "\ud800",
      "\udc00",
      "\ufffd",
      "+",
      "[",
      " ",
      "\t",
    ),
    { maxLength: PROPERTY_MAX_TEXT_PARTS },
  )
  .map((parts) => parts.join(""));
const STALE_DEPLOYMENT_ERROR_PREFIXES = Object.freeze([
  "Failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "Importing a module script failed",
  "Unable to preload CSS for",
  "Setting up fake worker failed",
]);
const errorMessageArbitrary = fc.oneof(
  searchTextArbitrary,
  fc.constantFrom(...STALE_DEPLOYMENT_ERROR_PREFIXES).chain((prefix) =>
    fc.oneof(
      fc.constant(prefix),
      searchTextArbitrary.map((suffix) => `${prefix}${suffix}`),
      searchTextArbitrary.map((leading) => `${leading}${prefix}`),
    ),
  ),
);
const loadErrorArbitrary = fc.oneof(
  errorMessageArbitrary.map((message) => ({ message })),
  errorMessageArbitrary,
  fc.constant(null),
  fc.constant({}),
  fc.constant({ message: 1 }),
);

describe("stale deployment load error classification", () => {
  test("recognizes the five supported message prefixes at the start", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: /assets/app.js",
      "error loading dynamically imported module: app.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/app.css",
      'Setting up fake worker failed: "Cannot load"',
    ]) {
      expect(isStaleDeploymentLoadError({ message })).toBe(true);
    }
  });

  test("requires an exact case-sensitive prefix with no leading whitespace", () => {
    expect(
      isStaleDeploymentLoadError({
        message: "Failed to fetch dynamically imported module",
      }),
    ).toBe(true);
    expect(
      isStaleDeploymentLoadError({
        message: " failed to fetch dynamically imported module",
      }),
    ).toBe(false);
    expect(
      isStaleDeploymentLoadError({
        message: "failed to fetch dynamically imported module",
      }),
    ).toBe(false);
  });

  test("rejects non-object errors and non-string messages", () => {
    expect(isStaleDeploymentLoadError(null)).toBe(false);
    expect(
      isStaleDeploymentLoadError("Failed to fetch dynamically imported module"),
    ).toBe(false);
    expect(isStaleDeploymentLoadError({ message: 12 })).toBe(false);
    expect(isStaleDeploymentLoadError({})).toBe(false);
  });

  test("stale deployment classification matches the previous prefix check for generated errors", () => {
    assertProperty(
      "stale deployment classification matches the previous prefix check for generated errors",
      fc.property(loadErrorArbitrary, (error) => {
        const message =
          typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
            ? error.message
            : undefined;
        const expected =
          message !== undefined &&
          STALE_DEPLOYMENT_ERROR_PREFIXES.some((prefix) =>
            message
              .slice(0, prefix.length)
              .toWellFormed()
              .includes(prefix.toWellFormed()),
          );
        expect(isStaleDeploymentLoadError(error)).toBe(expected);
      }),
    );
  });
});
