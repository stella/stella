import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  expectRegistryOutcome,
  expectRegistryResponse,
  registryExtras,
  registryString,
  forEachRegistryMutation,
} from "../shared/property-test-helpers.test.js";
import { validateVat } from "./client.js";
import { parseValidation } from "./parse.js";
import { isViesParticipant, VAT_FORMAT_RULES } from "./validation.js";

const response = fc.record({
  isValid: fc.boolean(),
  requestDate: registryString,
  userError: registryString,
  name: registryString,
  address: registryString,
  requestIdentifier: registryString,
  originalVatNumber: registryString,
  vatNumber: registryString,
});

test(
  "validation responses retain source dates and expose a typed status",
  () => {
    fc.assert(
      fc.property(response, registryExtras, (raw, extra) => {
        const vatNumber = { country: "DE", vat: "136695976" };
        const parsed = expectRegistryOutcome(() =>
          parseValidation({ ...extra, ...raw }, vatNumber),
        );
        expect(parsed?.vatNumber).toEqual(vatNumber);
        expect(parsed?.requestDate).toBe(raw.requestDate);
        expect(parsed?.valid).toBe(raw.isValid && raw.userError === "VALID");
        for (const key of ["name", "address"] as const) {
          const value = raw[key].trim();
          expect(parsed?.[key]).toBe(
            value === "" || value === "---" ? null : value,
          );
        }
        const errorStatuses = new Map([
          ["INVALID_INPUT", "invalid-format" as const],
          ["INVALID", "not-registered" as const],
        ]);
        const expected =
          raw.isValid && raw.userError === "VALID"
            ? "valid"
            : (errorStatuses.get(raw.userError) ?? "service-unavailable");
        expect(parsed?.status.type).toBe(expected);
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "JSON boundary rejects missing and mistyped response fields with registry errors",
  async () => {
    await fc.assert(
      fc.asyncProperty(response, async (raw) => {
        const original = await expectRegistryResponse(raw, async () =>
          validateVat("DE136695976", { observer: "unobserved" }),
        );
        expect(original?.requestDate).toBe(raw.requestDate);
        await forEachRegistryMutation(raw, async (payload) => {
          const parsed = await expectRegistryResponse(payload, async () =>
            validateVat("DE136695976", { observer: "unobserved" }),
          );
          if (parsed === undefined) {
            return;
          }
          expect(typeof parsed.requestDate).toBe("string");
          expect(typeof parsed.valid).toBe("boolean");
          expect(parsed.name === null || typeof parsed.name === "string").toBe(
            true,
          );
          expect(
            parsed.address === null || typeof parsed.address === "string",
          ).toBe(true);
        });
      }),
      propertyConfig({ numRuns: 5, seed: propertySeed() }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "participant lookup only reads explicitly declared country rules",
  () => {
    fc.assert(
      fc.property(registryString, (country) => {
        expect(isViesParticipant(country)).toBe(
          Object.hasOwn(VAT_FORMAT_RULES, country) &&
            VAT_FORMAT_RULES[country]?.removed !== true,
        );
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(10_000),
);
