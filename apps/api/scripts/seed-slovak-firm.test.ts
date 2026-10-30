import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { safeIdSchema } from "@stll/api-contract/safe-id";
import { validateIco } from "@stll/business-registries/orsr";
import {
  calculateDocumentTotals,
  parseIban,
  standardVatRateOn,
  VAT_RATE_PRESETS,
} from "@stll/invoicing";
import { timeEntryAmount } from "@stll/money";
import { assertProperty } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import { createSellerProfileBody } from "@/api/handlers/seller-profiles/schema";
import {
  decideInvoiceVat,
  isWellFormedEuVatId,
} from "@/api/lib/billing/invoice-prefill.logic";

import {
  buildSlovakFirmSeed,
  SLOVAK_SEED_PEOPLE,
} from "./seed-slovak-firm.data";

const FIXED_NOW = new Date("2026-10-30T10:15:00Z");

const assertCalendar = (now: Date) => {
  const seed = buildSlovakFirmSeed(now);
  const today = Temporal.Instant.fromEpochMilliseconds(now.getTime())
    .toZonedDateTimeISO("Europe/Bratislava")
    .toPlainDate();
  const monday = today.subtract({ days: today.dayOfWeek - 1 });
  const previousMonday = monday.subtract({ weeks: 1 });
  expect(seed.today).toBe(today.toString());
  expect(seed.monday).toBe(monday.toString());
  expect(seed.previousMonday).toBe(previousMonday.toString());
  const weeks = new Set<string>();
  for (const entry of seed.time) {
    expect(entry.dateWorked >= previousMonday.toString()).toBe(true);
    expect(entry.dateWorked <= today.toString()).toBe(true);
    weeks.add(entry.dateWorked < monday.toString() ? "previous" : "current");
  }
  expect(weeks).toEqual(new Set(["previous", "current"]));
  expect(seed.payment.paidOn <= today.toString()).toBe(true);
  expect(seed.timer.startedAt).toEqual(now);
  expect(seed.timer.lastResumedAt).toEqual(now);
};

describe("Slovak firm rehearsal seed", () => {
  test.each([
    "2026-10-30T10:15:00Z",
    "2026-10-25T23:30:00Z",
    "2026-03-29T22:30:00Z",
    "2027-01-03T23:30:00Z",
    "2026-01-01T00:15:00Z",
  ])("uses Bratislava calendar weeks at %s", (instant) =>
    assertCalendar(new Date(instant)),
  );

  test("Slovak seed dates remain in the current and previous weeks", () => {
    assertProperty(
      "Slovak seed dates remain in the current and previous weeks",
      fc.property(
        fc.integer({
          min: Date.parse("2025-02-01T00:00:00Z"),
          max: Date.parse("2030-12-31T23:59:59Z"),
        }),
        (instant) => assertCalendar(new Date(instant)),
      ),
    );
  });

  test("repeated builds preserve identities and all fixture values", () => {
    const seed = buildSlovakFirmSeed(FIXED_NOW);
    expect(buildSlovakFirmSeed(new Date(FIXED_NOW))).toEqual(seed);
    const rows = [
      seed.seller,
      ...seed.clients,
      ...seed.matters,
      ...seed.time,
      ...seed.invoiceRows,
      ...seed.lines,
      seed.payment,
      seed.timer,
    ];
    const ids = rows.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of rows) {
      expect(v.safeParse(safeIdSchema, row.id).success).toBe(true);
      expect(row.organizationId).toBe(seed.organizationId);
    }
    const later = buildSlovakFirmSeed(new Date("2027-01-04T10:15:00Z"));
    expect(later.time.map(({ id }) => id)).toEqual(
      seed.time.map(({ id }) => id),
    );
    expect(later.invoiceRows.map(({ id }) => id)).toEqual(
      seed.invoiceRows.map(({ id }) => id),
    );
  });

  test("fictional Slovak issuer and clients satisfy the owning validators", () => {
    const { seller, clients } = buildSlovakFirmSeed(FIXED_NOW);
    expect(v.safeParse(createSellerProfileBody, seller).success).toBe(true);
    expect(validateIco(seller.registrationId)).toBe(true);
    expect(isWellFormedEuVatId(seller.vatId)).toBe(true);
    expect(seller.vatId).toBe(`SK${seller.taxId}`);
    expect(BigInt(seller.taxId) % 11n).toBe(0n);
    expect(parseIban(seller.iban).isOk()).toBe(true);
    expect(seller.iban.startsWith("SK")).toBe(true);
    expect(seller.registerEntry).toContain("Fiktívny");
    expect(seller.barRegistration).toContain("Fiktívny");
    expect(seller.defaultCurrency).toBe("EUR");
    expect(clients.filter(({ type }) => type === "person")).toHaveLength(1);
    for (const client of clients) {
      if (client.registrationNumber !== undefined) {
        expect(validateIco(client.registrationNumber)).toBe(true);
      }
      if (client.taxId !== undefined) {
        expect(BigInt(client.taxId) % 11n).toBe(0n);
      }
      if (client.vatId !== undefined) {
        expect(isWellFormedEuVatId(client.vatId)).toBe(true);
      }
      expect(client.invoiceLanguage).toBe("sk");
      expect(client.currency).toBe("EUR");
    }
    expect(SLOVAK_SEED_PEOPLE.map(({ name }) => name)).toEqual([
      "Žofia Vymyslená",
      "Ľubomír Vymyslený",
    ]);
  });

  test("time covers submission, return, approval, billing and non-billable work", () => {
    const seed = buildSlovakFirmSeed(FIXED_NOW);
    expect(new Set(seed.time.map(({ status }) => status))).toEqual(
      new Set(["draft", "submitted", "approved", "billed"]),
    );
    const returned = seed.time.filter(({ returnedAt }) => returnedAt !== null);
    expect(returned).toHaveLength(1);
    for (const entry of returned) {
      expect(entry.status).toBe("draft");
      expect(entry.returnedByUserId).toBe(SLOVAK_SEED_PEOPLE[1].id);
      expect(entry.returnComment?.length).toBeGreaterThan(0);
    }
    for (const entry of seed.time) {
      expect(entry.currency).toBe("EUR");
      expect(entry.narrativeLanguage).toBe("sk");
      expect(entry.timezoneId).toBe("Europe/Bratislava");
      if (entry.status === "approved" || entry.status === "billed") {
        expect(entry.approvedByUserId).toBe(SLOVAK_SEED_PEOPLE[1].id);
        expect(entry.approvedAt).not.toBeNull();
      }
      if (!entry.billable) {
        expect(entry.billedMinutes).toBe(0);
      }
    }
    expect(
      seed.time.some(
        ({ status, invoiceId }) => status === "approved" && invoiceId === null,
      ),
    ).toBe(true);
    expect(seed.time.some(({ billable }) => !billable)).toBe(true);
    expect(
      seed.arrangements.filter(({ capMinutes }) => capMinutes !== null),
    ).toHaveLength(1);
    expect(
      seed.arrangements.find(({ capMinutes }) => capMinutes !== null)
        ?.capMinutes,
    ).toBe(600);
  });

  test("issued and ready-to-issue invoices agree with the tax and money owners", () => {
    const seed = buildSlovakFirmSeed(FIXED_NOW);
    expect(seed.invoiceRows).toHaveLength(2);
    expect(seed.invoiceRows.map(({ status }) => status).toSorted()).toEqual([
      "draft",
      "sent",
    ]);
    for (const invoice of seed.invoiceRows) {
      const invoiceLines = seed.lines.filter(
        ({ invoiceId }) => invoiceId === invoice.id,
      );
      expect(invoiceLines.length).toBeGreaterThan(0);
      const client = seed.clients.find(({ id }) => id === invoice.clientId);
      expect(client).toBeDefined();
      if (client === undefined) {
        panic("Seed invoice client missing");
      }
      const vat = decideInvoiceVat({
        seller: seed.seller,
        buyerVatId: client.vatId ?? null,
        buyerVatPayer: client.vatPayer,
        buyerCountry: client.billingAddress.country,
        standardRateBps: standardVatRateOn(
          VAT_RATE_PRESETS.SK,
          invoice.taxableSupplyDate ?? invoice.invoiceDate,
        ),
      });
      for (const line of invoiceLines) {
        expect(line.vatTreatment).toBe(vat.vatTreatment);
        expect(line.vatRateBps).toBe(vat.vatRateBps);
        const entry = seed.time.find(({ id }) => id === line.timeEntryId);
        expect(entry).toBeDefined();
        if (entry === undefined) {
          panic("Seed invoice entry missing");
        }
        expect(entry.status).toBe("billed");
        expect(entry.invoiceId).toBe(invoice.id);
        expect(entry.workspaceId).toBe(invoice.workspaceId);
        expect(line.netAmount).toBe(
          timeEntryAmount({ ...entry, noCharge: false }),
        );
      }
      const calculated = calculateDocumentTotals({
        documentType: "invoice",
        lines: invoiceLines.map((line) => ({
          description: line.description,
          netAmountMinor: line.netAmount,
          vatRateBps: line.vatRateBps,
          vatTreatment: line.vatTreatment,
        })),
      });
      expect(calculated.isOk()).toBe(true);
      if (calculated.isErr()) {
        panic(calculated.error.message);
      }
      expect(invoice.netAmount).toBe(calculated.value.totals.netAmountMinor);
      expect(invoice.vatAmount).toBe(calculated.value.totals.vatAmountMinor);
      expect(invoice.totalAmount).toBe(
        calculated.value.totals.grossAmountMinor,
      );
      expect(invoice.language).toBe("sk");
      expect(invoice.currency).toBe("EUR");
      expect(invoice.sellerProfileId).toBe(seed.seller.id);
      expect(invoice.buyerName).toBe(client.displayName);
      if (invoice.status === "sent") {
        expect(invoice.netAmount).toBe(19_871);
        expect(invoice.vatAmount).toBe(4570);
        expect(invoice.totalAmount).toBe(24_441);
        expect(invoice.invoiceNumber).toMatch(/^SK-\d{4}-0001$/u);
        expect(invoice.finalizedAt).toBeInstanceOf(Date);
        expect(invoice.sentAt).toBeInstanceOf(Date);
        expect(invoice.paidAt).toBeNull();
        expect(seed.payment.invoiceId).toBe(invoice.id);
        expect(seed.payment.amount).toBeGreaterThan(0);
        expect(seed.payment.amount).toBeLessThan(invoice.totalAmount);
      } else {
        expect(invoice.invoiceNumber).toBeNull();
        expect(invoice.finalizedAt).toBeNull();
        expect(invoice.buyerVatId).toBeTruthy();
        expect(vat.vatTreatment).toBe("reverse_charge");
      }
    }
  });
});
