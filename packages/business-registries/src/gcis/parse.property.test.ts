import { expect, test } from "bun:test";
import fc from "fast-check";
import { Temporal } from "temporal-polyfill/full";

import { propertyConfig, propertySeed } from "@stll/property-testing";

import {
  expectNullableString,
  expectRegistryOutcome,
  expectRegistryResponse,
  forEachRegistryMutation,
  mutatedRegistryPayload,
  registryMutation,
  registryString,
} from "../shared/property-test-helpers.test.js";
import { lookupByTaxId } from "./client.js";
import { parseCompany, parseSearchEntry } from "./parse.js";
import type { GcisCompany, GcisRawCompany } from "./types.js";

const rocDate = fc.oneof(
  registryString,
  fc.constantFrom("0760221", "1150525", "1150230", "1150101", "1160101"),
);
const company = fc
  .record(
    {
      Business_Accounting_NO: registryString,
      Company_Name: registryString,
      Company_Status: fc.oneof(
        registryString,
        fc.constantFrom("01", "05", "06"),
      ),
      Company_Status_Desc: fc.oneof(
        registryString,
        fc.constantFrom("核准設立", "解散", "停業"),
      ),
      Capital_Stock_Amount: fc.double(),
      Paid_In_Capital_Amount: fc.double(),
      Responsible_Name: registryString,
      Company_Location: registryString,
      Register_Organization_Desc: registryString,
      Company_Setup_Date: rocDate,
      Change_Of_Approval_Data: rocDate,
      Sus_Beg_Date: rocDate,
      Sus_End_Date: rocDate,
    },
    { requiredKeys: ["Business_Accounting_NO"] },
  )
  .map((raw) => raw satisfies GcisRawCompany);
const now = new Date("2026-09-30T00:00:00.000Z");

test("company projections expose validated dates and finite capital with explicit status", () => {
  fc.assert(
    fc.property(company, (raw) => {
      const output = expectRegistryOutcome(() => parseCompany(raw, now));
      if (output === undefined) {
        return;
      }
      expect(output.taxId).toBe(raw.Business_Accounting_NO);
      expect(output.name).toBe(
        raw.Company_Name?.trim() || raw.Business_Accounting_NO,
      );
      expect(["active", "suspended", "dissolved", "unknown"]).toContain(
        output.status.type,
      );
      for (const value of [output.capitalAmount, output.paidInCapitalAmount]) {
        expect(value === null || Number.isFinite(value)).toBe(true);
      }
      for (const date of [output.setupDate, output.lastChangeDate]) {
        if (date !== null) {
          expect(Temporal.PlainDate.from(date).toString()).toBe(date);
        }
      }
      for (const value of [
        output.setupDateRoc,
        output.lastChangeDateRoc,
        output.location,
        output.responsibleName,
        output.registerOrganization,
      ]) {
        expectNullableString(value);
      }
      expect(parseSearchEntry(raw, now)).toEqual({
        taxId: output.taxId,
        name: output.name,
        location: output.location,
        status: output.status,
      });
    }),
    propertyConfig({ seed: propertySeed() }),
  );
});

const expectTypedOutput = (output: GcisCompany) => {
  expect(typeof output.taxId).toBe("string");
  expect(typeof output.name).toBe("string");
  expect(["active", "suspended", "dissolved", "unknown"]).toContain(
    output.status.type,
  );
  for (const value of [output.capitalAmount, output.paidInCapitalAmount]) {
    expect(value === null || Number.isFinite(value)).toBe(true);
  }
  for (const value of [
    output.location,
    output.responsibleName,
    output.setupDateRoc,
    output.lastChangeDateRoc,
    output.statusDescription,
  ]) {
    expectNullableString(value);
  }
  for (const date of [output.setupDate, output.lastChangeDate]) {
    expectNullableString(date);
    if (date !== null) {
      expect(Temporal.PlainDate.from(date).toString()).toBe(date);
    }
  }
};

test("company response mutations retain typed dates and capital or registry failures", async () => {
  await fc.assert(
    fc.asyncProperty(
      company,
      fc.nat(),
      registryMutation,
      async (raw, selected, mutation) => {
        const original = [
          {
            ...raw,
            Business_Accounting_NO: "22099131",
            Capital_Stock_Amount: Number.isFinite(raw.Capital_Stock_Amount)
              ? raw.Capital_Stock_Amount
              : undefined,
            Paid_In_Capital_Amount: Number.isFinite(raw.Paid_In_Capital_Amount)
              ? raw.Paid_In_Capital_Amount
              : undefined,
          },
        ];
        const operation = () => lookupByTaxId("22099131");
        expect(await expectRegistryResponse(original, operation)).toMatchObject(
          { taxId: "22099131", name: raw.Company_Name?.trim() || "22099131" },
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
  const original = [
    {
      Business_Accounting_NO: "22099131",
      Company_Name: "公司",
      Company_Status: "01",
      Company_Status_Desc: "核准設立",
      Capital_Stock_Amount: 1000,
      Paid_In_Capital_Amount: 500,
      Responsible_Name: "姓名",
      Company_Location: "地址",
      Register_Organization_Desc: "登記機關",
      Company_Setup_Date: "0760221",
      Change_Of_Approval_Data: "1150101",
      Sus_Beg_Date: "1150101",
      Sus_End_Date: "1160101",
    } satisfies GcisRawCompany,
  ];
  const operation = () => lookupByTaxId("22099131");
  expect(await expectRegistryResponse(original, operation)).toMatchObject({
    taxId: "22099131",
    name: "公司",
  });
  await forEachRegistryMutation(original, async (payload) => {
    const output = await expectRegistryResponse(payload, operation);
    if (output) {
      expectTypedOutput(output);
    }
  });
});
