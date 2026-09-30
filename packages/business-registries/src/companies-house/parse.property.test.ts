import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  expectRegistryResponse,
  registryString,
  registryExtras,
  forEachRegistryMutation,
  expectRegistryOutcome,
  expectNullableString,
} from "../shared/property-test-helpers.test.js";
import {
  lookupByCompanyNumber,
  lookupOfficersByCompanyNumber,
  searchByName,
} from "./client.js";
import {
  parseAddress,
  parseCompanyProfile,
  parseOfficer,
  parseSearchItem,
} from "./parse.js";
import type {
  CompaniesHouseRawAddress,
  CompaniesHouseRawCompanyProfile,
  CompaniesHouseRawOfficer,
} from "./types.js";

const address = fc
  .record(
    {
      premises: registryString,
      address_line_1: registryString,
      address_line_2: registryString,
      locality: registryString,
      region: registryString,
      postal_code: registryString,
      country: registryString,
      care_of: registryString,
      po_box: registryString,
    },
    { requiredKeys: [] },
  )
  .map((raw) => raw satisfies CompaniesHouseRawAddress);
const profile = fc
  .record(
    {
      company_name: registryString,
      company_number: registryString,
      company_status: registryString,
      date_of_creation: registryString,
      date_of_cessation: registryString,
      registered_office_address: address,
      service_address: address,
      sic_codes: fc.array(registryString, { maxLength: 4 }),
      previous_company_names: fc.array(
        fc.record(
          {
            name: registryString,
            effective_from: registryString,
            ceased_on: registryString,
          },
          { requiredKeys: ["name"] },
        ),
        { maxLength: 4 },
      ),
      accounts: fc.record(
        {
          last_accounts: fc.record(
            { period_end_on: registryString, made_up_to: registryString },
            { requiredKeys: [] },
          ),
          next_accounts: fc.record(
            {
              period_end_on: registryString,
              due_on: registryString,
              overdue: fc.boolean(),
            },
            { requiredKeys: [] },
          ),
          next_due: registryString,
        },
        { requiredKeys: [] },
      ),
    },
    { requiredKeys: ["company_name", "company_number"] },
  )
  .map((raw) => raw satisfies CompaniesHouseRawCompanyProfile);
const officer = fc
  .record(
    {
      name: registryString,
      officer_role: registryString,
      resigned_on: registryString,
      appointed_on: registryString,
      appointed_before: registryString,
      address,
      principal_office_address: address,
      date_of_birth: fc.record(
        {
          day: fc.oneof(registryString, fc.integer()),
          month: fc.oneof(registryString, fc.integer()),
          year: fc.oneof(registryString, fc.integer()),
        },
        { requiredKeys: [] },
      ),
      identification: fc.record(
        { registration_number: registryString, legal_form: registryString },
        { requiredKeys: [] },
      ),
    },
    { requiredKeys: ["name", "officer_role"] },
  )
  .map((raw) => raw satisfies CompaniesHouseRawOfficer);

test(
  "profile and search retain source identity and dates across nested optional data",
  () => {
    fc.assert(
      fc.property(profile, registryExtras, (raw, extras) => {
        const enriched = { extraFields: extras, ...raw };
        const searchRaw = { ...enriched, title: raw.company_name };
        const parsed = expectRegistryOutcome(() =>
          parseCompanyProfile(enriched),
        );
        const search = expectRegistryOutcome(() => parseSearchItem(searchRaw));
        if (!parsed || !search) {
          return;
        }
        expect(parsed.companyNumber).toBe(raw.company_number);
        expect(parsed.name).toBe(raw.company_name);
        expect(search.companyNumber).toBe(parsed.companyNumber);
        expect(search.name).toBe(parsed.name);
        expect(search.status).toEqual(parsed.status);
        expect(parsed.dateOfCreation).toBe(
          raw.date_of_creation?.trim() || null,
        );
        expect(
          parsed.registryUrl.endsWith(
            encodeURIComponent(raw.company_number.toWellFormed()),
          ),
        ).toBe(true);
        expect(parsed.previousNames.map((row) => row.name)).toEqual(
          (raw.previous_company_names ?? []).map((row) => row.name),
        );
        expect(parsed.registeredOfficeAddress).toEqual(
          raw.registered_office_address
            ? parseAddress(raw.registered_office_address)
            : null,
        );
        const currentDue =
          raw.accounts?.next_accounts?.due_on?.trim() ||
          raw.accounts?.next_due?.trim() ||
          null;
        expect(parsed.accounts?.nextDue ?? null).toBe(currentDue);
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 80 }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "officers retain names and roles while exposing only valid month and year",
  () => {
    fc.assert(
      fc.property(officer, registryExtras, (raw, extras) => {
        const enriched = { extraFields: extras, ...raw };
        const parsed = expectRegistryOutcome(() => parseOfficer(enriched));
        if (!parsed) {
          return;
        }
        expect(parsed.name).toBe(raw.name);
        expect(parsed.role.code).toBe(raw.officer_role);
        expect(parsed.appointedBefore).toBe(
          raw.appointed_before?.trim() || null,
        );
        expect(parsed.isResigned).toBe(Boolean(raw.resigned_on?.trim()));
        const pickedAddress = raw.address ?? raw.principal_office_address;
        expect(parsed.address).toEqual(
          pickedAddress ? parseAddress(pickedAddress) : null,
        );
        if (parsed.dateOfBirth) {
          expect(Object.keys(parsed.dateOfBirth).toSorted()).toEqual([
            "month",
            "year",
          ]);
          expect(Number.isInteger(parsed.dateOfBirth.month)).toBe(true);
          expect(parsed.dateOfBirth.month).toBeGreaterThanOrEqual(1);
          expect(parsed.dateOfBirth.month).toBeLessThanOrEqual(12);
          expect(Number.isInteger(parsed.dateOfBirth.year)).toBe(true);
        }
        expectNullableString(parsed.identification?.registrationNumber ?? null);
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 80 }),
    );
  },
  propertyTestTimeout(10_000),
);

test.each(["profile", "search", "officers"] as const)(
  "%s response fields return normalized values or typed errors",
  async (kind) => {
    const filename = {
      profile: "company-tesco.json",
      search: "search-tesco.json",
      officers: "officers-tesco.json",
    }[kind];
    const fixture: unknown = await Bun.file(
      new URL(`__fixtures__/${filename}`, import.meta.url),
    ).json();
    const supplementalOfficer = {
      name: "Corporate officer",
      officer_role: "corporate-director",
      appointed_on: "2020-01-01",
      appointed_before: "1992-01-01",
      resigned_on: "2026-01-01",
      occupation: "Director",
      nationality: "British",
      country_of_residence: "United Kingdom",
      principal_office_address: {
        premises: "1",
        address_line_1: "Street",
        address_line_2: "Area",
        care_of: "Agent",
        po_box: "2",
        locality: "City",
        region: "Region",
        postal_code: "AB1 2CD",
        country: "United Kingdom",
      },
      identification: {
        identification_type: "uk-limited-company",
        legal_authority: "Act",
        legal_form: "Limited",
        place_registered: "England",
        registration_number: "00445790",
      },
      date_of_birth: { day: 1, month: 1, year: 1980 },
    } satisfies CompaniesHouseRawOfficer;
    const supplemental =
      kind === "officers" ? { items: [supplementalOfficer] } : undefined;
    const operation = async () => {
      const config = { apiKey: "fixture" };
      switch (kind) {
        case "profile":
          return await lookupByCompanyNumber("00445790", config);
        case "search":
          return await searchByName("Tesco", config);
        case "officers":
          return await lookupOfficersByCompanyNumber("00445790", config);
        default:
          return kind satisfies never;
      }
    };
    for (const payload of supplemental === undefined
      ? [fixture]
      : [fixture, supplemental]) {
      const baseline = await expectRegistryResponse(payload, operation);
      expect(baseline).toBeDefined();
      expect(baseline).not.toBeNull();
      if (Array.isArray(baseline)) {
        expect(baseline.length).toBeGreaterThan(0);
      }
      await forEachRegistryMutation(payload, async (mutated) => {
        const result = await expectRegistryResponse(mutated, operation);
        if (!result) {
          return;
        }
        if (Array.isArray(result)) {
          for (const row of result) {
            expect(typeof row.name).toBe("string");
            if ("companyNumber" in row) {
              expect(typeof row.companyNumber).toBe("string");
              expectNullableString(row.address);
              expectNullableString(row.type);
              expectNullableString(row.dateOfCreation);
              expectNullableString(row.dateOfCessation);
            }
            if ("role" in row) {
              expect(typeof row.role.code).toBe("string");
              expect(typeof row.isResigned).toBe("boolean");
              for (const value of [
                row.appointedOn,
                row.appointedBefore,
                row.resignedOn,
                row.occupation,
                row.nationality,
                row.countryOfResidence,
              ]) {
                expectNullableString(value);
              }
              if (row.address) {
                for (const value of Object.values(row.address)) {
                  expectNullableString(value);
                }
              }
              if (row.identification) {
                for (const value of Object.values(row.identification)) {
                  expectNullableString(value);
                }
              }
              if (row.dateOfBirth) {
                expect(Number.isInteger(row.dateOfBirth.month)).toBe(true);
                expect(row.dateOfBirth.month).toBeGreaterThanOrEqual(1);
                expect(row.dateOfBirth.month).toBeLessThanOrEqual(12);
                expect(Number.isInteger(row.dateOfBirth.year)).toBe(true);
              }
            }
          }
          return;
        }
        expect(result.companyNumber).toBe("00445790");
        expect(typeof result.name).toBe("string");
        for (const value of [
          result.statusDetail,
          result.type,
          result.subtype,
          result.jurisdiction,
          result.dateOfCreation,
          result.dateOfCessation,
        ]) {
          expectNullableString(value);
        }
        for (const parsedAddress of [
          result.registeredOfficeAddress,
          result.serviceAddress,
        ]) {
          if (parsedAddress) {
            for (const value of Object.values(parsedAddress))
              {expectNullableString(value);}
          }
        }
        for (const code of result.sicCodes) {
          expect(typeof code).toBe("string");
        }
        for (const previousName of result.previousNames) {
          expect(typeof previousName.name).toBe("string");
          expectNullableString(previousName.effectiveFrom);
          expectNullableString(previousName.ceasedOn);
        }
        if (result.accounts) {
          for (const value of [
            result.accounts.lastMadeUpTo,
            result.accounts.nextMadeUpTo,
            result.accounts.nextDue,
          ]) {
            expectNullableString(value);
          }
        }
        if (result.confirmationStatement) {
          for (const value of [
            result.confirmationStatement.lastMadeUpTo,
            result.confirmationStatement.nextMadeUpTo,
            result.confirmationStatement.nextDue,
          ]) {
            expectNullableString(value);
          }
        }
        for (const value of [
          result.hasCharges,
          result.hasBeenLiquidated,
          result.hasInsolvencyHistory,
        ]) {
          expect(value === null || typeof value === "boolean").toBe(true);
        }
        if (result.accounts) {
          expect(typeof result.accounts.overdue).toBe("boolean");
        }
        if (result.confirmationStatement) {
          expect(typeof result.confirmationStatement.overdue).toBe("boolean");
        }
      });
    }
  },
  propertyTestTimeout(10_000),
);
