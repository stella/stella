import { panic } from "better-result";

import {
  calculateDocumentTotals,
  standardVatRateOn,
  VAT_RATE_PRESETS,
} from "@stll/invoicing";
import { timeEntryAmount } from "@stll/money";

import type {
  contacts,
  invoiceLines,
  invoices,
  sellerProfiles,
  timeEntries,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";

import { seedId } from "./seed-utils";

export const SLOVAK_SEED_ORG_ID = toSafeId<"organization">(
  "seed-slovak-fictional-firm",
);
export const SLOVAK_SEED_PEOPLE = [
  {
    id: toSafeId<"user">("seed-sk-zofia"),
    name: "Žofia Vymyslená",
    email: "zofia@slovak-firm.example.test",
    role: "member",
  },
  {
    id: toSafeId<"user">("seed-sk-lubomir"),
    name: "Ľubomír Vymyslený",
    email: "lubomir@slovak-firm.example.test",
    role: "owner",
  },
] as const;

const buildSlovakParties = () => {
  const organizationId = SLOVAK_SEED_ORG_ID;
  const seller = {
    id: seedId<"sellerProfile">("sk-seller"),
    organizationId,
    legalName: "Vymyslená advokátska kancelária, s. r. o.",
    registrationId: "99999994",
    taxId: "9999999900",
    vatId: "SK9999999900",
    vatPayer: true,
    registerEntry:
      "Fiktívny zápis: Mestský súd Bratislava III, oddiel Sro, vložka 999999/Z",
    barRegistration: "Fiktívny zápis SAK č. 999999",
    addressLine1: "Vymyslená 99",
    city: "Bratislava",
    postalCode: "811 01",
    country: "SK",
    iban: "SK9011000000009999999999",
    bic: "TATRSKBX",
    defaultCurrency: "EUR",
    isDefault: true,
    footerNotes: "Výlučne fiktívne údaje na miestne skúšanie.",
  } satisfies typeof sellerProfiles.$inferInsert;
  const clients = [
    {
      id: seedId<"contact">("sk-client-business"),
      organizationId,
      type: "organization",
      displayName: "Fiktívne dielne, s. r. o.",
      organizationName: "Fiktívne dielne, s. r. o.",
      registrationNumber: "99999986",
      taxId: "9999999801",
      vatId: "SK9999999801",
      vatPayer: true,
      billingAddress: {
        line1: "Vymyslená 98",
        city: "Žilina",
        postalCode: "010 01",
        country: "SK",
      },
      currency: "EUR",
      defaultHourlyRate: cents(12_550),
      invoiceLanguage: "sk",
    },
    {
      id: seedId<"contact">("sk-client-eu"),
      organizationId,
      type: "organization",
      displayName: "Fiktivní dílny EU s.r.o.",
      organizationName: "Fiktivní dílny EU s.r.o.",
      registrationNumber: "99999978",
      vatId: "CZ99999978",
      vatPayer: true,
      billingAddress: {
        line1: "Smyšlená 97",
        city: "Brno",
        postalCode: "602 00",
        country: "CZ",
      },
      currency: "EUR",
      defaultHourlyRate: cents(15_000),
      invoiceLanguage: "sk",
    },
    {
      id: seedId<"contact">("sk-client-person"),
      organizationId,
      type: "person",
      displayName: "Božena Vymyslená",
      firstName: "Božena",
      lastName: "Vymyslená",
      vatPayer: false,
      billingAddress: {
        line1: "Vymyslená 96",
        city: "Prešov",
        postalCode: "080 01",
        country: "SK",
      },
      currency: "EUR",
      defaultHourlyRate: cents(10_000),
      invoiceLanguage: "sk",
    },
  ] satisfies (typeof contacts.$inferInsert)[];
  return { seller, clients };
};

const buildSlovakMatters = (
  clients: ReturnType<typeof buildSlovakParties>["clients"],
  approver: SafeId<"user">,
) =>
  clients.map((client, index) => ({
    id: seedId<"workspace">(`sk-matter-${index}`),
    organizationId: SLOVAK_SEED_ORG_ID,
    clientId: client.id,
    name:
      [
        "Príprava dodávateľskej zmluvy",
        "Cezhraničné právne poradenstvo",
        "Vyporiadanie spoluvlastníctva",
      ][index] ?? panic("Missing Slovak matter name"),
    reference: `SK-${index + 1}`,
    leadUserId: approver,
  }));

type SlovakTimeDefinitionsOptions = {
  today: string;
  monday: string;
  previousMonday: string;
};

const buildSlovakTimeDefinitions = ({
  today,
  monday,
  previousMonday,
}: SlovakTimeDefinitionsOptions) =>
  [
    {
      label: "draft",
      status: "draft",
      dateWorked: today,
      minutes: 35,
      billable: true,
    },
    {
      label: "submitted",
      status: "submitted",
      dateWorked: previousMonday,
      minutes: 90,
      billable: true,
    },
    {
      label: "returned",
      status: "draft",
      dateWorked: previousMonday,
      minutes: 25,
      billable: true,
    },
    {
      label: "approved",
      status: "approved",
      dateWorked: previousMonday,
      minutes: 75,
      billable: true,
    },
    {
      label: "nonbillable",
      status: "draft",
      dateWorked: today,
      minutes: 30,
      billable: false,
    },
    {
      label: "issued",
      status: "billed",
      dateWorked: previousMonday,
      minutes: 95,
      billable: true,
    },
    {
      label: "invoice-draft",
      status: "billed",
      dateWorked: monday,
      minutes: 45,
      billable: true,
    },
  ] as const;

// Calendar arithmetic uses date-only UTC values after resolving the Bratislava
// date. This keeps weeks stable across DST and the host machine's timezone.
const buildSlovakCalendar = (now: Date) => {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Bratislava",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const date = new Date(`${today}T12:00:00Z`);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  const day = (offset: number) => {
    const value = new Date(date);
    value.setUTCDate(value.getUTCDate() - daysSinceMonday + offset);
    return value.toISOString().slice(0, 10);
  };
  const previousMonday = day(-7);
  const monday = day(0);
  return { today, daysSinceMonday, day, previousMonday, monday };
};

export const buildSlovakFirmSeed = (now: Date) => {
  const organizationId = SLOVAK_SEED_ORG_ID;
  const { today, daysSinceMonday, day, previousMonday, monday } =
    buildSlovakCalendar(now);
  const timekeeper = SLOVAK_SEED_PEOPLE[0].id;
  const approver = toSafeId<"user">(SLOVAK_SEED_PEOPLE[1].id);
  const { seller, clients } = buildSlovakParties();
  const matters = buildSlovakMatters(clients, approver);
  const business = matters[0] ?? panic("Missing Slovak business matter");
  const eu = matters[1] ?? panic("Missing EU matter");
  const issuedId = seedId<"invoice">("sk-issued-invoice");
  const draftId = seedId<"invoice">("sk-draft-invoice");
  const approvedAt = new Date(`${day(-5)}T16:00:00Z`);
  const definitions = buildSlovakTimeDefinitions({
    today,
    monday,
    previousMonday,
  });
  const time = definitions.map(
    ({ label, status, dateWorked, minutes, billable }) => {
      const matter = label === "invoice-draft" ? eu : business;
      const client =
        clients.find(({ id }) => id === matter.clientId) ??
        panic("Missing time client");
      let invoiceId = label === "issued" ? issuedId : null;
      if (label === "invoice-draft") {
        invoiceId = draftId;
      }
      const reviewedAt = label === "invoice-draft" ? now : approvedAt;
      return {
        id: seedId<"timeEntry">(`sk-time-${label}`),
        organizationId,
        workspaceId: matter.id,
        userId: timekeeper,
        approverUserId: approver,
        dateWorked,
        timezoneId: "Europe/Bratislava",
        durationMinutes: minutes,
        billedMinutes: billable ? minutes : 0,
        rateAtEntry: client.defaultHourlyRate,
        currency: "EUR",
        narrative:
          label === "returned"
            ? "Príprava návrhu zmluvy"
            : "Právna analýza a príprava zmluvných podkladov",
        narrativeLanguage: "sk",
        billable,
        status,
        invoiceId,
        approvedByUserId:
          status === "approved" || status === "billed" ? approver : null,
        approvedAt:
          status === "approved" || status === "billed" ? reviewedAt : null,
        returnedByUserId: label === "returned" ? approver : null,
        returnedAt: label === "returned" ? approvedAt : null,
        returnComment:
          label === "returned"
            ? "Prosím, doplňte konkrétne ustanovenia a výsledok právnej analýzy."
            : null,
      } satisfies typeof timeEntries.$inferInsert;
    },
  );
  const documents = time.flatMap((entry) => {
    if (entry.invoiceId === null) {
      return [];
    }
    const issued = entry.invoiceId === issuedId;
    const client = clients[issued ? 0 : 1] ?? panic("Missing invoice client");
    const netAmount = timeEntryAmount({
      rateAtEntry: entry.rateAtEntry,
      billedMinutes: entry.billedMinutes,
      noCharge: false,
    });
    const vatRateBps = issued
      ? standardVatRateOn(VAT_RATE_PRESETS.SK, previousMonday)
      : 0;
    if (vatRateBps === null) {
      panic("Missing Slovak standard VAT period");
    }
    const priced = calculateDocumentTotals({
      documentType: "invoice",
      lines: [
        {
          description: entry.narrative,
          netAmountMinor: netAmount,
          vatRateBps,
          vatTreatment: issued ? "domestic_vat" : "reverse_charge",
        },
      ],
    });
    if (priced.isErr()) {
      panic(priced.error.message);
    }
    const line =
      priced.value.lines.at(0) ?? panic("Missing priced invoice line");
    const invoice = {
      id: entry.invoiceId,
      organizationId,
      workspaceId: entry.workspaceId,
      clientId: client.id,
      sellerProfileId: seller.id,
      documentType: "invoice",
      status: issued ? "sent" : "draft",
      invoiceNumber: issued ? `SK-${day(-4).slice(0, 4)}-0001` : null,
      invoiceDate: issued ? day(-4) : today,
      taxableSupplyDate: entry.dateWorked,
      dueDate: issued ? day(10) : day(daysSinceMonday + 14),
      currency: "EUR",
      language: "sk",
      buyerName: client.displayName,
      buyerRegistrationId: client.registrationNumber,
      buyerTaxId: client.taxId,
      buyerVatId: client.vatId,
      buyerAddressLine1: client.billingAddress.line1,
      buyerCity: client.billingAddress.city,
      buyerPostalCode: client.billingAddress.postalCode,
      buyerCountry: client.billingAddress.country,
      finalizedAt: issued ? new Date(`${day(-4)}T12:00:00Z`) : null,
      sentAt: issued ? new Date(`${day(-4)}T12:05:00Z`) : null,
      paidAt: null,
      netAmount: cents(priced.value.totals.netAmountMinor),
      vatAmount: cents(priced.value.totals.vatAmountMinor),
      totalAmount: cents(priced.value.totals.grossAmountMinor),
    } satisfies typeof invoices.$inferInsert;
    const invoiceLine = {
      id: seedId<"invoiceLine">(`sk-line-${issued ? "issued" : "draft"}`),
      organizationId,
      workspaceId: entry.workspaceId,
      invoiceId: entry.invoiceId,
      position: 0,
      description: entry.narrative,
      quantity: String(entry.billedMinutes / 60),
      unit: "h",
      unitPrice: entry.rateAtEntry,
      vatRateBps,
      vatTreatment: line.vatTreatment,
      netAmount: line.netAmountMinor,
      vatAmount: line.vatAmountMinor,
      grossAmount: line.grossAmountMinor,
      source: "time_entry",
      timeEntryId: entry.id,
      recordedDescription: entry.narrative,
      recordedQuantity: String(entry.durationMinutes / 60),
      recordedUnit: "h",
      recordedUnitPrice: entry.rateAtEntry,
      recordedNetAmount: netAmount,
    } satisfies typeof invoiceLines.$inferInsert;
    return [{ invoice, invoiceLine }];
  });
  const invoiceRows = documents.map(({ invoice }) => invoice);
  const lines = documents.map(({ invoiceLine }) => invoiceLine);
  const arrangements = matters.map(
    (matter, index) =>
      ({
        workspaceId: matter.id,
        organizationId,
        mode: "hourly",
        currency: "EUR",
        capMinutes: index === 2 ? 600 : null,
        alertThresholdBps: index === 2 ? 8000 : null,
      }) as const,
  );
  return {
    organizationId,
    today,
    monday,
    previousMonday,
    seller,
    clients,
    matters,
    arrangements,
    time,
    invoiceRows,
    lines,
    payment: {
      id: seedId<"invoicePayment">("sk-partial-payment"),
      organizationId,
      invoiceId: issuedId,
      amount: cents(10_000),
      paidOn: day(-2),
      method: "bank_transfer",
      origin: "recorded",
      recordedBy: approver,
      reference: "Fiktívna čiastočná úhrada",
    } as const,
    timer: {
      id: seedId<"timeTimer">("sk-running-timer"),
      organizationId,
      userId: timekeeper,
      workspaceId: business.id,
      description: "Príprava stanoviska k zmluve",
      state: "running",
      startedAt: now,
      lastResumedAt: now,
      accumulatedSeconds: 0,
    } as const,
  };
};
