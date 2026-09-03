import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { propertyConfig } from "@stll/property-testing";

import {
  CONFIGURATION_PLACEHOLDERS,
  isConfigurationPlaceholder,
  resolveConfigurationPlaceholders,
} from "@/api/lib/configuration-placeholders";
import { credentialsFromEnvValues } from "@/api/lib/s3-credentials";

const schema = {
  REQUIRED_VALUE: v.string(),
  OPTIONAL_VALUE: v.optional(v.string()),
};

describe("configuration placeholders", () => {
  test("an optional credential holding a placeholder reads as absent", () => {
    expect(
      credentialsFromEnvValues("PLACEHOLDER_SET_ME", "PLACEHOLDER_SET_ME"),
    ).toBeNull();
    expect(
      credentialsFromEnvValues("UNCONFIGURED", "a-real-secret"),
    ).toBeNull();

    const { runtimeEnv, violation } = resolveConfigurationPlaceholders({
      schema,
      values: {
        OPTIONAL_VALUE: "UNCONFIGURED",
        REQUIRED_VALUE: "a-real-value",
      },
    });
    expect(runtimeEnv["OPTIONAL_VALUE"]).toBeUndefined();
    expect(violation).toBeNull();
  });

  test("a required value holding a placeholder fails validation by name", () => {
    const { runtimeEnv, violation } = resolveConfigurationPlaceholders({
      schema,
      values: {
        OPTIONAL_VALUE: "a-real-value",
        REQUIRED_VALUE: "PLACEHOLDER_SET_ME",
      },
    });

    expect(runtimeEnv["REQUIRED_VALUE"]).toBeUndefined();
    expect(violation).toContain("REQUIRED_VALUE");
    expect(violation).not.toContain("OPTIONAL_VALUE");
  });

  test("a real value survives untouched", () => {
    const { runtimeEnv, violation } = resolveConfigurationPlaceholders({
      schema,
      values: {
        OPTIONAL_VALUE: "use-iam-roles-elsewhere",
        REQUIRED_VALUE: "unconfigured-region",
      },
    });

    expect(runtimeEnv["OPTIONAL_VALUE"]).toBe("use-iam-roles-elsewhere");
    expect(runtimeEnv["REQUIRED_VALUE"]).toBe("unconfigured-region");
    expect(violation).toBeNull();
  });

  test("no casing or padding of a sentinel ever reaches a consumer", () => {
    const padding = fc.stringMatching(/^[ \t\r\n]{0,4}$/u);
    const recased = (sentinel: string) =>
      fc
        .array(fc.boolean(), {
          minLength: sentinel.length,
          maxLength: sentinel.length,
        })
        .map((upper) =>
          upper
            .map((isUpper, index) =>
              isUpper
                ? sentinel.charAt(index).toUpperCase()
                : sentinel.charAt(index),
            )
            .join(""),
        );
    // The empty sentinel carries no padding: padding it produces a
    // whitespace-only value, which is malformed rather than unset.
    const sentinelValue = fc
      .constantFrom(...CONFIGURATION_PLACEHOLDERS)
      .chain((sentinel) =>
        sentinel === ""
          ? fc.constant("")
          : fc
              .tuple(padding, recased(sentinel), padding)
              .map(([before, cased, after]) => `${before}${cased}${after}`),
      );

    fc.assert(
      fc.property(sentinelValue, (value) => {
        expect(isConfigurationPlaceholder(value)).toBe(true);
        expect(credentialsFromEnvValues(value, value)).toBeNull();

        const { runtimeEnv, violation } = resolveConfigurationPlaceholders({
          schema,
          values: { OPTIONAL_VALUE: value, REQUIRED_VALUE: value },
        });
        expect(runtimeEnv["OPTIONAL_VALUE"]).toBeUndefined();
        expect(runtimeEnv["REQUIRED_VALUE"]).toBeUndefined();
        // Every sentinel reads as unset; only a seeded literal is named,
        // because an empty value is what "unset" already looks like.
        expect(violation === null).toBe(value === "");
        if (violation !== null) {
          expect(violation).toContain("REQUIRED_VALUE");
        }
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("a placeholder in a derivation input is reported by name", () => {
    const { runtimeEnv, violation } = resolveConfigurationPlaceholders({
      schema,
      values: { REQUIRED_VALUE: "a-real-value", DERIVED_PART: "UNCONFIGURED" },
      derivationInputs: { DERIVED_PART: v.optional(v.string()) },
    });

    expect(runtimeEnv["DERIVED_PART"]).toBeUndefined();
    expect(violation).toContain("DERIVED_PART");
  });

  test("an empty database password stays a password, not an unset one", () => {
    const { runtimeEnv, violation } = resolveConfigurationPlaceholders({
      schema,
      values: { REQUIRED_VALUE: "a-real-value", DB_PASSWORD: "" },
      derivationInputs: { DB_PASSWORD: v.optional(v.string()) },
    });

    expect(runtimeEnv["DB_PASSWORD"]).toBe("");
    expect(violation).toBeNull();
  });

  test("a whitespace-only value stays a value, not an unset one", () => {
    expect(isConfigurationPlaceholder("   ")).toBe(false);
    expect(
      resolveConfigurationPlaceholders({
        schema,
        values: { REQUIRED_VALUE: "   " },
      }).runtimeEnv["REQUIRED_VALUE"],
    ).toBe("   ");
  });
});
