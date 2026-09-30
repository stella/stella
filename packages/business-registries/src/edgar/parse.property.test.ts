import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertySeed } from "@stll/property-testing";

import {
  expectNullableString,
  expectRegistryOutcome,
  expectRegistryResponse,
  forEachRegistryMutation,
  mutatedRegistryPayload,
  registryMutation,
  nullableRegistryString,
  registryString,
} from "../shared/property-test-helpers.test.js";
import { lookupByCik } from "./client.js";
import { parseAddress, parseSubmission } from "./parse.js";
import type {
  EdgarCompany,
  EdgarRawAddress,
  EdgarRawSubmission,
} from "./types.js";

const address = fc
  .record({
    street1: nullableRegistryString,
    street2: nullableRegistryString,
    city: nullableRegistryString,
    stateOrCountry: nullableRegistryString,
    zipCode: nullableRegistryString,
    stateOrCountryDescription: nullableRegistryString,
    country: nullableRegistryString,
    countryCode: nullableRegistryString,
  })
  .map((raw) => raw satisfies EdgarRawAddress);
const column = fc.array(registryString, { maxLength: 12 });
const submission = fc
  .record(
    {
      cik: registryString,
      name: registryString,
      entityType: fc.oneof(registryString, fc.constant("operating")),
      sic: registryString,
      sicDescription: registryString,
      ein: registryString,
      tickers: column,
      exchanges: column,
      addresses: fc.record(
        {
          mailing: address,
          business: address,
        },
        { requiredKeys: [] },
      ),
      formerNames: fc.array(
        fc.record({
          name: registryString,
          from: nullableRegistryString,
          to: nullableRegistryString,
        }),
        { maxLength: 5 },
      ),
      filings: fc.record({
        recent: fc.record({
          accessionNumber: column,
          form: column,
          filingDate: fc.array(
            fc.oneof(
              registryString,
              fc.constantFrom("2026-09-01", "2000-01-01", "2026-02-30"),
            ),
            { maxLength: 12 },
          ),
          reportDate: column,
          acceptanceDateTime: column,
          primaryDocument: column,
          primaryDocDescription: column,
        }),
      }),
    },
    {
      requiredKeys: [
        "cik",
        "name",
        "tickers",
        "exchanges",
        "addresses",
        "formerNames",
        "filings",
      ],
    },
  )
  .map((raw) => raw satisfies EdgarRawSubmission);
const now = Date.parse("2026-09-30T00:00:00.000Z");

test("submissions retain source names and zip bounded filings without losing column alignment", () => {
  fc.assert(
    fc.property(submission, (raw) => {
      const output = expectRegistryOutcome(() => parseSubmission(raw, { now }));
      if (output === undefined) {
        return;
      }
      expect(output.cik).toBe(raw.cik);
      expect(output.name).toBe(raw.name);
      expect(output.tickers).toEqual(raw.tickers);
      expect(output.exchanges).toEqual(raw.exchanges);
      expect(["active", "stale", "unknown"]).toContain(output.status.type);
      expect(output.recentFilings.length).toBeLessThanOrEqual(5);
      const columns = raw.filings.recent;
      const eligible = columns.accessionNumber
        .flatMap((accessionNumber, index) => {
          const form = columns.form.at(index);
          const filingDate = columns.filingDate.at(index);
          return accessionNumber && form && filingDate
            ? [{ accessionNumber, form, filingDate, index }]
            : [];
        })
        .slice(0, 5);
      expect(output.recentFilings.length).toBe(eligible.length);
      for (const [index, filing] of output.recentFilings.entries()) {
        const source = eligible.at(index);
        expect(source).toBeDefined();
        expect(source?.accessionNumber).toBe(filing.accessionNumber);
        expect(source?.form).toBe(filing.form);
        expect(source?.filingDate).toBe(filing.filingDate);
        if (source) {
          expect(filing.reportDate).toBe(
            columns.reportDate.at(source.index)?.trim() || null,
          );
        }
        for (const value of [
          filing.reportDate,
          filing.acceptanceDateTime,
          filing.primaryDocument,
          filing.primaryDocDescription,
        ]) {
          expectNullableString(value);
        }
      }
      for (const kind of ["mailing", "business"] as const) {
        const source = raw.addresses[kind];
        expect(output.addresses[kind]).toEqual(
          source ? parseAddress(source) : null,
        );
        const parsed = output.addresses[kind];
        if (parsed) {
          for (const value of Object.values(parsed)) {
            expectNullableString(value);
          }
        }
      }
      expect(output.formerNames.length).toBe(raw.formerNames.length);
      for (const [index, former] of output.formerNames.entries()) {
        expect(raw.formerNames.at(index)?.name).toBe(former.name);
        expectNullableString(former.from);
        expectNullableString(former.to);
      }
      if (output.status.type === "stale") {
        expect(output.recentFilings.at(0)?.filingDate).toBe(
          output.status.lastFilingDate,
        );
      }
    }),
    propertyConfig({ seed: propertySeed() }),
  );
});

const expectTypedOutput = (output: EdgarCompany) => {
  expect(typeof output.cik).toBe("string");
  expect(typeof output.name).toBe("string");
  for (const value of [output.sic, output.sicDescription, output.ein]) {
    expectNullableString(value);
  }
  for (const value of [...output.tickers, ...output.exchanges]) {
    expect(typeof value).toBe("string");
  }
  expect(["active", "stale", "unknown"]).toContain(output.status.type);
  expect(output.recentFilings.length).toBeLessThanOrEqual(5);
  for (const filing of output.recentFilings) {
    expect(typeof filing.accessionNumber).toBe("string");
    expect(typeof filing.form).toBe("string");
    expect(typeof filing.filingDate).toBe("string");
    for (const value of [
      filing.reportDate,
      filing.acceptanceDateTime,
      filing.primaryDocument,
      filing.primaryDocDescription,
    ]) {
      expectNullableString(value);
    }
  }
  for (const parsedAddress of Object.values(output.addresses)) {
    if (parsedAddress) {
      for (const value of Object.values(parsedAddress)) {
        expectNullableString(value);
      }
    }
  }
  for (const former of output.formerNames) {
    expect(typeof former.name).toBe("string");
    expectNullableString(former.from);
    expectNullableString(former.to);
  }
};

test("submission response mutations retain typed nested filings or registry failures", async () => {
  await fc.assert(
    fc.asyncProperty(
      submission,
      fc.nat(),
      registryMutation,
      async (raw, selected, mutation) => {
        const original = { ...raw, cik: "0000320193" };
        const operation = () =>
          lookupByCik("320193", {
            userAgent: "Property Tests property@example.test",
          });
        expect(await expectRegistryResponse(original, operation)).toMatchObject(
          { cik: "0000320193", name: raw.name },
        );
        const payload = mutatedRegistryPayload({
          payload: original,
          selected,
          mutation,
        });
        const output = await expectRegistryResponse(payload, operation);
        if (!output) {
          return;
        }
        expectTypedOutput(output);
      },
    ),
    propertyConfig({ seed: propertySeed(), numRuns: 20 }),
  );
});

test("every consumed response field supports missing, null and wrong-type mutations", async () => {
  const office = {
    street1: "1 Main Street",
    street2: "Suite 2",
    city: "City",
    stateOrCountry: "CA",
    zipCode: "01234",
    stateOrCountryDescription: "California",
    country: "United States",
    countryCode: "US",
  } satisfies EdgarRawAddress;
  const original = {
    cik: "0000320193",
    name: "Issuer",
    entityType: "operating",
    sic: "3571",
    sicDescription: "Computers",
    ein: "942404110",
    tickers: ["TEST"],
    exchanges: ["Nasdaq"],
    addresses: { mailing: { ...office }, business: { ...office } },
    formerNames: [
      { name: "Former Issuer", from: "2000-01-01", to: "2001-01-01" },
    ],
    filings: {
      recent: {
        accessionNumber: ["0001"],
        filingDate: ["2026-09-01"],
        reportDate: ["2026-08-31"],
        acceptanceDateTime: ["2026-09-01T10:00:00Z"],
        form: ["10-K"],
        primaryDocument: ["filing.htm"],
        primaryDocDescription: ["Annual report"],
      },
    },
  } satisfies EdgarRawSubmission;
  const operation = () =>
    lookupByCik("320193", {
      userAgent: "Property Tests property@example.test",
    });
  expect(await expectRegistryResponse(original, operation)).toMatchObject({
    cik: "0000320193",
    name: "Issuer",
  });
  await forEachRegistryMutation(original, async (payload) => {
    const output = await expectRegistryResponse(payload, operation);
    if (output) {
      expectTypedOutput(output);
    }
  });
});
