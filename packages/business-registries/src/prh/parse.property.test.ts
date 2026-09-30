import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  registryString,
  registryExtras,
  expectRegistryResponse,
  forEachRegistryMutation,
  expectRegistryOutcome,
  expectNullableString,
} from "../shared/property-test-helpers.test.js";
import { lookupByBusinessId } from "./client.js";
import { parseAddress, parseCompany, parseSearchEntry } from "./parse.js";
import type { PrhRawAddress, PrhRawCompany } from "./types.js";

const address = fc
  .record(
    {
      type: fc.integer({ min: 0, max: 3 }),
      source: registryString,
      street: registryString,
      buildingNumber: registryString,
      entrance: registryString,
      apartmentNumber: registryString,
      apartmentIdSuffix: registryString,
      postOfficeBox: registryString,
      co: registryString,
      freeAddressLine: registryString,
      postCode: registryString,
      country: registryString,
      endDate: registryString,
      postOffices: fc.array(
        fc.record({
          city: registryString,
          languageCode: fc.oneof(
            registryString,
            fc.constantFrom("1", "2", "3"),
          ),
        }),
        { maxLength: 4 },
      ),
    },
    { requiredKeys: ["type", "source"] },
  )
  .map((raw) => raw satisfies PrhRawAddress);
const names = fc.array(
  fc.record(
    {
      name: registryString,
      type: fc.oneof(registryString, fc.constantFrom("1", "2", "3")),
      version: fc.integer(),
      source: registryString,
      endDate: registryString,
    },
    { requiredKeys: ["name", "type", "version", "source"] },
  ),
  { maxLength: 5 },
);
const descriptions = fc.array(
  fc.record({
    languageCode: fc.oneof(registryString, fc.constantFrom("1", "2", "3")),
    description: registryString,
  }),
  { maxLength: 4 },
);
const entity = fc
  .record(
    {
      businessId: fc.record({ value: registryString, source: registryString }),
      names,
      mainBusinessLine: fc.record(
        {
          type: registryString,
          descriptions,
          typeCodeSet: registryString,
          source: registryString,
        },
        { requiredKeys: ["type", "descriptions", "typeCodeSet", "source"] },
      ),
      addresses: fc.array(address, { maxLength: 4 }),
      companyForms: fc.array(
        fc.record(
          {
            type: registryString,
            descriptions,
            version: fc.integer(),
            source: registryString,
            endDate: registryString,
          },
          { requiredKeys: ["type", "descriptions", "version", "source"] },
        ),
        { maxLength: 4 },
      ),
      status: fc.oneof(registryString, fc.constantFrom("1", "2", "3")),
      tradeRegisterStatus: registryString,
      endDate: registryString,
      registrationDate: registryString,
    },
    { requiredKeys: ["businessId"] },
  )
  .map((raw) => raw satisfies PrhRawCompany);

test(
  "company and search share identity and preserve the documented name fallback",
  () => {
    fc.assert(
      fc.property(entity, registryExtras, (raw, extras) => {
        const enriched = { extraFields: extras, ...raw };
        const parsed = expectRegistryOutcome(() => parseCompany(enriched));
        const search = expectRegistryOutcome(() => parseSearchEntry(enriched));
        if (!parsed || !search) {
          return;
        }
        expect(parsed.businessId).toBe(raw.businessId.value);
        expect(search.businessId).toBe(parsed.businessId);
        expect(search.name).toBe(parsed.name);
        const activeName = raw.names?.find(
          (row) => row.type === "1" && !row.endDate,
        );
        if (activeName) {
          expect(parsed.name).toBe(activeName.name);
        }
        if (!raw.names?.length) {
          expect(parsed.name).toBe(raw.businessId.value);
        }
        expect(parsed.alternateNames.length).toBe(
          (raw.names?.length ?? 0) - (activeName ? 1 : 0),
        );
        expect(parsed.registeredAt).toBe(raw.registrationDate ?? null);
        expect(
          parsed.registryUrl.endsWith(
            encodeURIComponent(raw.businessId.value.toWellFormed()),
          ),
        ).toBe(true);
        if (raw.status === "3") {
          expect(parsed.status).toEqual({
            type: "ended",
            endedAt: raw.endDate ?? null,
          });
        }
        if (raw.status !== "1" && raw.status !== "2" && raw.status !== "3") {
          expect(parsed.status.type).toBe("unknown");
        }
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 80 }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "localized address parsing keeps postal and country atoms and source city",
  () => {
    fc.assert(
      fc.property(address, registryExtras, (raw, extras) => {
        const enriched = { extraFields: extras, ...raw };
        const parsed = expectRegistryOutcome(() => parseAddress(enriched));
        if (!parsed) {
          return;
        }
        expect(parsed.postalCode).toBe(raw.postCode ?? null);
        expect(parsed.country).toBe(raw.country ?? null);
        if (parsed.city !== null) {
          expect(raw.postOffices?.some((row) => row.city === parsed.city)).toBe(
            true,
          );
        }
        if (!raw.postOffices?.length) {
          expect(parsed.city).toBeNull();
        }
        for (const value of Object.values(parsed)) {
          expectNullableString(value);
        }
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 80 }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "client responses validate generated missing, null and wrong nested field types",
  async () => {
    await fc.assert(
      fc.asyncProperty(entity, async (raw) => {
        const baseline = await expectRegistryResponse(
          { totalResults: 1, companies: [raw] },
          () => lookupByBusinessId("0112038-9"),
        );
        expect(baseline?.businessId).toBe(raw.businessId.value);
        await forEachRegistryMutation(
          { totalResults: 1, companies: [raw] },
          async (mutated) => {
            const parsed = await expectRegistryResponse(mutated, () =>
              lookupByBusinessId("0112038-9"),
            );
            if (parsed === undefined) {
              return;
            }
            if (!parsed) {
              return;
            }
            expect(parsed.businessId).toBe(raw.businessId.value);
            expect(typeof parsed.name).toBe("string");
            expect(
              parsed.name === raw.businessId.value ||
                raw.names?.some((row) => row.name === parsed.name),
            ).toBe(true);
            expectNullableString(parsed.legalForm);
            expectNullableString(parsed.legalFormCode);
            expectNullableString(parsed.registeredAt);
            expectNullableString(parsed.endedAt);
            if (parsed.mainBusinessLine) {
              expect(typeof parsed.mainBusinessLine.code).toBe("string");
              expectNullableString(parsed.mainBusinessLine.description);
            }
            for (const parsedAddress of [
              parsed.streetAddress,
              parsed.postalAddress,
            ]) {
              if (parsedAddress) {
                for (const value of Object.values(parsedAddress)) {
                  expectNullableString(value);
                }
              }
            }
          },
        );
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 5 }),
    );
  },
  propertyTestTimeout(10_000),
);
