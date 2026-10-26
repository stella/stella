import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { user as authUser } from "@/api/db/auth-schema";
import {
  contacts,
  expenses,
  featureEnrolments,
  invoices,
  numberSeries,
  organizationSettings,
  sellerProfiles,
  timeEntries,
  vatRates,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { SafeHandlerLogContext } from "@/api/lib/api-handlers";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type { MemberRole } from "@/api/lib/member-roles";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import createInvoice from "./create";
import prefillInvoice from "./prefill";
import transitionInvoice from "./transition";

setDefaultTimeout(120_000);
let db: TestDatabase;
let ids: TestIds;
const entryIds: SafeId<"timeEntry">[] = [];
const expenseIds: SafeId<"expense">[] = [];
const invoiceIds: SafeId<"invoice">[] = [];
const sellerIds: SafeId<"sellerProfile">[] = [];
const vatRateIds: SafeId<"vatRate">[] = [];
const seriesIds: SafeId<"numberSeries">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  db = fixture.testDb;
  ids = fixture.ids;
  await db
    .update(authUser)
    .set({ emailVerified: true })
    .where(inArray(authUser.id, [ids.userA1]));
  await db
    .insert(featureEnrolments)
    .values([
      {
        organizationId: ids.orgA,
        userId: ids.userA1,
        featureId: "time-billing",
      },
    ])
    .onConflictDoNothing();
});

afterEach(async () => {
  if (invoiceIds.length) {
    await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
  }
  if (entryIds.length) {
    await db.delete(timeEntries).where(inArray(timeEntries.id, entryIds));
  }
  if (expenseIds.length) {
    await db.delete(expenses).where(inArray(expenses.id, expenseIds));
  }
  if (seriesIds.length) {
    await db.delete(numberSeries).where(inArray(numberSeries.id, seriesIds));
  }
  if (sellerIds.length) {
    await db
      .delete(sellerProfiles)
      .where(inArray(sellerProfiles.id, sellerIds));
  }
  if (vatRateIds.length) {
    await db.delete(vatRates).where(inArray(vatRates.id, vatRateIds));
  }
  await db
    .update(contacts)
    .set({
      taxId: null,
      registrationNumber: null,
      billingAddress: null,
      paymentTermDays: null,
    })
    .where(eq(contacts.id, ids.contactA2));
  for (const list of [
    invoiceIds,
    entryIds,
    expenseIds,
    seriesIds,
    sellerIds,
    vatRateIds,
  ]) {
    list.length = 0;
  }
});
afterAll(releaseRlsFixture);

const context = <TContext extends SafeHandlerLogContext>(
  _handler: (context: TContext) => unknown,
  body: unknown,
  {
    params = {},
    query = {},
    role = "owner",
  }: {
    params?: Record<string, unknown>;
    query?: Record<string, unknown>;
    role?: MemberRole;
  } = {},
): TContext =>
  asTestRaw<TContext>({
    body,
    params: { workspaceId: ids.wsA2, ...params },
    query,
    workspaceId: ids.wsA2,
    safeDb: createSafeDb(db, [ids.wsA2], ids.orgA, ids.userA1),
    scopedDb: createScopedDb(db, [ids.wsA2], ids.orgA, ids.userA1),
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
    request: new Request("https://example.test/invoices", { method: "PUT" }),
    route: "/test/invoice-prefill",
    memberRole: sessionMemberRole(role),
    getWorkspaceAccess: async () => ({ id: ids.wsA2, status: "active" }),
    getActiveWorkspaceIds: async () => [ids.wsA2],
    getAccessibleWorkspaces: async () => [{ id: ids.wsA2, status: "active" }],
    recordAuditEvent: async () => {},
    createAuditRecorder: () => async () => {},
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    promptCachingEnabled: false,
  });

const seedEntry = async (dateWorked: string, billedMinutes = 90) => {
  const id = createSafeId<"timeEntry">();
  entryIds.push(id);
  await db.insert(timeEntries).values({
    id,
    organizationId: ids.orgA,
    workspaceId: ids.wsA2,
    userId: ids.userA1,
    dateWorked,
    timezoneId: "UTC",
    durationMinutes: billedMinutes,
    billedMinutes,
    rateAtEntry: cents(250_000),
    currency: "CZK",
    status: "approved",
    narrative: `Drafting on ${dateWorked}`,
  });
  return id;
};

const seedExpense = async (dateIncurred: string, amount: number) => {
  const id = createSafeId<"expense">();
  expenseIds.push(id);
  await db.insert(expenses).values({
    id,
    organizationId: ids.orgA,
    workspaceId: ids.wsA2,
    userId: ids.userA1,
    matterId: ids.entityA2,
    dateIncurred,
    amount: cents(amount),
    currency: "CZK",
    category: "filing_fee",
    description: "Court fee",
    status: "approved",
  });
  return id;
};

const seedSeller = async (vatId: string | null, vatPayer = vatId !== null) => {
  const id = createSafeId<"sellerProfile">();
  sellerIds.push(id);
  await db.insert(sellerProfiles).values({
    id,
    organizationId: ids.orgA,
    legalName: "Example Legal s.r.o.",
    registrationId: "12345678",
    vatId,
    vatPayer,
    defaultCurrency: "CZK",
    iban: "CZ6508000000192000145399",
    isDefault: true,
  });
  return id;
};

const seedVatRates = async () => {
  for (const [code, rateBps] of [
    ["standard", 2100],
    ["reduced", 1200],
  ] as const) {
    const id = createSafeId<"vatRate">();
    vatRateIds.push(id);
    // db-await-in-loop: two fixture rows
    await db.insert(vatRates).values({
      id,
      organizationId: ids.orgA,
      code,
      name: code,
      rateBps,
      validFrom: "2020-01-01",
    });
  }
};

// The standard rate rises on 2026-09-20, between the two seeded work dates.
const seedVatRateChange = async () => {
  for (const [rateBps, validFrom, validTo] of [
    [2100, "2020-01-01", "2026-09-20"],
    [2300, "2026-09-20", null],
  ] as const) {
    const id = createSafeId<"vatRate">();
    vatRateIds.push(id);
    // db-await-in-loop: two fixture rows
    await db.insert(vatRates).values({
      id,
      organizationId: ids.orgA,
      code: "standard",
      name: "standard",
      rateBps,
      validFrom,
      validTo,
    });
  }
};

const setClient = async ({
  taxId,
  vatId = null,
  country = "CZ",
}: {
  taxId: string;
  vatId?: string | null;
  country?: string;
}) => {
  await db
    .update(contacts)
    .set({
      taxId,
      vatId,
      vatPayer: vatId === null ? null : true,
      registrationNumber: "87654321",
      billingAddress: {
        line1: "Na Příkopě 1",
        city: "Praha",
        postalCode: "110 00",
        country,
      },
      paymentTermDays: 30,
    })
    .where(eq(contacts.id, ids.contactA2));
};

type CreateBody = Parameters<typeof createInvoice.handler>[0]["body"];
const create = async (body: Partial<CreateBody>, role?: MemberRole) => {
  const result = await createInvoice.handler(
    context(
      createInvoice.handler,
      {
        invoiceDate: "2026-10-12",
        currency: "CZK",
        timeEntryIds: [],
        ...body,
      },
      role === undefined ? {} : { role },
    ),
  );
  if ("id" in result) {
    invoiceIds.push(result.id);
  }
  return result;
};

const readInvoice = async (id: SafeId<"invoice">) =>
  (await db.query.invoices.findFirst({
    where: { id: { eq: id } },
    with: { lines: { orderBy: { position: "asc" } } },
  })) ?? panic("Created invoice is missing");

const createdId = (result: Awaited<ReturnType<typeof create>>) =>
  "id" in result ? result.id : panic(JSON.stringify(result));

describe("invoice prefill", () => {
  test("creation freezes explicit, client, organization and seller language precedence", async () => {
    const previousContact =
      (await db.query.contacts.findFirst({
        where: { id: { eq: ids.contactA2 } },
        columns: { invoiceLanguage: true },
      })) ?? panic("Invoice client fixture is missing");
    const previousSettings = await db.query.organizationSettings.findFirst({
      where: { organizationId: { eq: ids.orgA } },
      columns: { invoiceLanguage: true },
    });
    const seller = await seedSeller(null);
    await db
      .update(sellerProfiles)
      .set({ country: "SK" })
      .where(eq(sellerProfiles.id, seller));
    try {
      await db
        .update(contacts)
        .set({ invoiceLanguage: null })
        .where(eq(contacts.id, ids.contactA2));
      await db
        .insert(organizationSettings)
        .values({
          organizationId: ids.orgA,
          invoiceLanguage: null,
        })
        .onConflictDoUpdate({
          target: organizationSettings.organizationId,
          set: { invoiceLanguage: null },
        });
      const sellerDefault = createdId(
        await create({ sellerProfileId: seller }),
      );
      await db
        .update(organizationSettings)
        .set({ invoiceLanguage: "de" })
        .where(eq(organizationSettings.organizationId, ids.orgA));
      const organizationDefault = createdId(
        await create({ sellerProfileId: seller }),
      );
      await db
        .update(contacts)
        .set({ invoiceLanguage: "fr" })
        .where(eq(contacts.id, ids.contactA2));
      const clientDefault = createdId(
        await create({ sellerProfileId: seller }),
      );
      const explicit = createdId(
        await create({ sellerProfileId: seller, language: "pl" }),
      );
      // Read every document after the defaults changed: language is a stored snapshot.
      const documents = await Promise.all(
        [sellerDefault, organizationDefault, clientDefault, explicit].map(
          async (id) => await readInvoice(id),
        ),
      );
      expect(documents.map((document) => document.language)).toEqual([
        "sk",
        "de",
        "fr",
        "pl",
      ]);
    } finally {
      await db
        .update(contacts)
        .set(previousContact)
        .where(eq(contacts.id, ids.contactA2));
      if (previousSettings === undefined) {
        await db
          .delete(organizationSettings)
          .where(eq(organizationSettings.organizationId, ids.orgA));
      } else {
        await db
          .update(organizationSettings)
          .set(previousSettings)
          .where(eq(organizationSettings.organizationId, ids.orgA));
      }
    }
  });

  test("a VAT payer billing a domestic client charges the standard rate and copies the buyer", async () => {
    const seller = await seedSeller("CZ12345678");
    await seedVatRates();
    await setClient({ taxId: "87654321", vatId: "CZ87654321" });
    const early = await seedEntry("2026-09-02");
    const late = await seedEntry("2026-09-30");

    const id = createdId(await create({ timeEntryIds: [early, late] }));
    const invoice = await readInvoice(id);

    expect(invoice).toMatchObject({
      sellerProfileId: seller,
      buyerName: "Contact A2",
      buyerRegistrationId: "87654321",
      buyerTaxId: "87654321",
      buyerVatId: "CZ87654321",
      buyerAddressLine1: "Na Příkopě 1",
      buyerCity: "Praha",
      buyerPostalCode: "110 00",
      buyerCountry: "CZ",
      taxableSupplyDate: "2026-09-30",
      dueDate: "2026-11-11",
      // 2 × 1.5 h × 2,500.00 = 7,500.00 net; 21 % VAT per line.
      netAmount: 750_000,
      vatAmount: 157_500,
      totalAmount: 907_500,
    });
    expect(
      invoice.lines.map((line) => [line.vatTreatment, line.vatRateBps]),
    ).toEqual([
      ["domestic_vat", 2100],
      ["domestic_vat", 2100],
    ]);
  });

  test("a seller without a VAT ID is not a VAT payer", async () => {
    await seedSeller(null);
    await seedVatRates();
    await setClient({ taxId: "87654321", vatId: "CZ87654321" });
    const entry = await seedEntry("2026-09-15");

    const invoice = await readInvoice(
      createdId(await create({ timeEntryIds: [entry] })),
    );

    expect(invoice.lines.at(0)).toMatchObject({
      vatTreatment: "not_vat_payer",
      vatRateBps: 0,
    });
    expect(invoice.totalAmount).toBe(cents(375_000));
  });

  test("a registered person with a VAT ID who is not a payer charges no VAT", async () => {
    await seedSeller("CZ12345678", false);
    await seedVatRates();
    await setClient({ taxId: "87654321", vatId: "CZ87654321" });
    const entry = await seedEntry("2026-09-15");

    const prefill = await prefillInvoice.handler(
      context(prefillInvoice.handler, {}),
    );
    expect(prefill).toMatchObject({
      seller: { vatId: "CZ12345678", vatPayer: false },
      vat: {
        vatTreatment: "not_vat_payer",
        vatRateBps: 0,
        reason: "seller_not_vat_payer",
      },
    });
    const invoice = await readInvoice(
      createdId(await create({ timeEntryIds: [entry] })),
    );
    expect(invoice.lines.at(0)).toMatchObject({
      vatTreatment: "not_vat_payer",
      vatRateBps: 0,
    });
    expect(invoice.vatAmount).toBe(cents(0));
  });

  test("a business client registered in another member state is reverse charged", async () => {
    await seedSeller("CZ12345678");
    await seedVatRates();
    await setClient({
      taxId: "298765432",
      vatId: "DE298765432",
      country: "DE",
    });
    const entry = await seedEntry("2026-09-15");

    const prefill = await prefillInvoice.handler(
      context(prefillInvoice.handler, {}),
    );
    expect(prefill).toMatchObject({
      currency: "CZK",
      sellerSource: "default",
      buyerSource: "client",
      vat: {
        vatTreatment: "reverse_charge",
        vatRateBps: 0,
        reason: "reverse_charge",
      },
      dueDays: 30,
      dueDaysSource: "client",
      taxableSupplyDate: "2026-09-15",
      timeEntries: [{ id: entry, billedMinutes: 90 }],
    });

    const invoice = await readInvoice(
      createdId(await create({ timeEntryIds: [entry] })),
    );
    expect(invoice.lines.at(0)).toMatchObject({
      vatTreatment: "reverse_charge",
      vatRateBps: 0,
    });
    expect(invoice.vatAmount).toBe(cents(0));
  });

  test("a business client outside the EU is invoiced outside the scope of VAT", async () => {
    await seedSeller("CZ12345678");
    await seedVatRates();
    await setClient({ taxId: "GB123456789", country: "GB" });
    const entry = await seedEntry("2026-09-15");

    const prefill = await prefillInvoice.handler(
      context(prefillInvoice.handler, {}),
    );
    expect(prefill).toMatchObject({
      vat: {
        vatTreatment: "outside_scope",
        vatRateBps: 0,
        reason: "outside_scope",
      },
    });

    const invoice = await readInvoice(
      createdId(await create({ timeEntryIds: [entry] })),
    );
    expect(invoice.lines.at(0)).toMatchObject({
      vatTreatment: "outside_scope",
      vatRateBps: 0,
    });
    expect(invoice.vatAmount).toBe(cents(0));
  });

  test("a free-text tax ID of a Czech client keeps the standard rate", async () => {
    await seedSeller("CZ12345678");
    await seedVatRates();
    await setClient({ taxId: "HRB123456" });
    const entry = await seedEntry("2026-09-15");

    const prefill = await prefillInvoice.handler(
      context(prefillInvoice.handler, {}),
    );
    expect(prefill).toMatchObject({
      vat: {
        vatTreatment: "domestic_vat",
        vatRateBps: 2100,
        reason: "domestic_rate",
      },
    });
    const invoice = await readInvoice(
      createdId(await create({ timeEntryIds: [entry] })),
    );
    expect(invoice.lines.at(0)).toMatchObject({
      vatTreatment: "domestic_vat",
      vatRateBps: 2100,
    });
    expect(invoice.vatAmount).toBe(cents(78_750));
  });

  test("without a seller profile lines keep 0 % VAT and explicit dates win", async () => {
    const entry = await seedEntry("2026-09-15");

    const invoice = await readInvoice(
      createdId(
        await create({
          timeEntryIds: [entry],
          dueDate: null,
          taxableSupplyDate: "2026-09-20",
        }),
      ),
    );

    expect(invoice).toMatchObject({
      sellerProfileId: null,
      dueDate: null,
      taxableSupplyDate: "2026-09-20",
      vatAmount: 0,
    });
  });
});

describe("invoice create with expenses and billed-time changes", () => {
  test("bills expenses and adjusted entries in one call and issues the draft", async () => {
    await seedSeller("CZ12345678");
    await seedVatRates();
    await setClient({ taxId: "87654321", vatId: "CZ87654321" });
    const written = await seedEntry("2026-09-10", 120);
    const waived = await seedEntry("2026-09-11", 30);
    const fee = await seedExpense("2026-09-12", 60_000);
    const seriesId = createSafeId<"numberSeries">();
    seriesIds.push(seriesId);
    await db.insert(numberSeries).values({
      id: seriesId,
      organizationId: ids.orgA,
      documentType: "invoice",
      name: "Invoices",
      pattern: "PF-{YYYY}-{SEQ}",
      padding: 4,
      isDefault: true,
    });

    const id = createdId(
      await create({
        timeEntryIds: [written, waived],
        expenseIds: [fee],
        entryAdjustments: [
          { timeEntryId: written, billedMinutes: 60, noCharge: false },
          { timeEntryId: waived, billedMinutes: 30, noCharge: true },
        ],
      }),
    );
    const invoice = await readInvoice(id);
    // 1 h × 2,500.00 + no-charge entry + 600.00 expense = 3,100.00 net.
    expect(invoice).toMatchObject({
      netAmount: 310_000,
      vatAmount: 65_100,
      totalAmount: 375_100,
      taxableSupplyDate: "2026-09-12",
    });
    expect(invoice.lines.map((line) => line.source)).toEqual([
      "time_entry",
      "time_entry",
      "expense",
    ]);
    expect(
      await db.query.timeEntries.findFirst({ where: { id: { eq: written } } }),
    ).toMatchObject({ billedMinutes: 60, durationMinutes: 120 });
    expect(
      await db.query.expenses.findFirst({ where: { id: { eq: fee } } }),
    ).toMatchObject({ status: "billed", invoiceId: id });

    const issued = await transitionInvoice.handler(
      context(
        transitionInvoice.handler,
        { action: "finalize" },
        { params: { invoiceId: id } },
      ),
    );
    expect(issued).toEqual({ id });
    expect(await readInvoice(id)).toMatchObject({
      status: "finalized",
      invoiceNumber: "PF-2026-0001",
    });
  });

  test("changing billed time needs approval rights", async () => {
    const entry = await seedEntry("2026-09-10", 120);

    const result = await create(
      {
        timeEntryIds: [entry],
        entryAdjustments: [
          { timeEntryId: entry, billedMinutes: 60, noCharge: false },
        ],
      },
      "member",
    );

    expect(result).toMatchObject({
      code: 403,
      response: { code: "entry_adjustment_forbidden" },
    });
    expect(
      await db.query.timeEntries.findFirst({ where: { id: { eq: entry } } }),
    ).toMatchObject({
      billedMinutes: 120,
      status: "approved",
      invoiceId: null,
    });
  });

  test("an adjustment must name an included entry", async () => {
    const included = await seedEntry("2026-09-10");
    const other = await seedEntry("2026-09-11");

    const result = await create({
      timeEntryIds: [included],
      entryAdjustments: [
        { timeEntryId: other, billedMinutes: 30, noCharge: false },
      ],
    });

    expect(result).toMatchObject({
      code: 400,
      response: { code: "invalid_entry_adjustments" },
    });
  });

  test("billing only work before a rate change uses the earlier rate, and a stale reviewed total is refused", async () => {
    await seedSeller("CZ12345678");
    await seedVatRateChange();
    await setClient({ taxId: "87654321", vatId: "CZ87654321" });
    const early = await seedEntry("2026-09-02");
    await seedEntry("2026-09-30");

    const prefill = await prefillInvoice.handler(
      context(prefillInvoice.handler, {}),
    );
    // All unbilled work ends on 2026-09-30, after the change.
    expect(prefill).toMatchObject({
      taxableSupplyDate: "2026-09-30",
      vat: { vatTreatment: "domestic_vat", vatRateBps: 2300 },
      vatRatePeriods: expect.arrayContaining([
        { validFrom: "2020-01-01", validTo: "2026-09-20", rateBps: 2100 },
        { validFrom: "2026-09-20", validTo: null, rateBps: 2300 },
      ]),
    });

    // 1.5 h × 2,500.00 = 3,750.00 net. A total reviewed at 23 % is stale once
    // the later entry is left out, so nothing is created.
    const stale = await create({
      timeEntryIds: [early],
      taxableSupplyDate: "2026-09-02",
      expectedTotalAmount: 461_250,
    });
    expect(stale).toMatchObject({
      code: 409,
      response: { code: "invoice_total_changed" },
    });
    expect(
      await db.query.timeEntries.findFirst({ where: { id: { eq: early } } }),
    ).toMatchObject({ status: "approved", invoiceId: null });

    const id = createdId(
      await create({
        timeEntryIds: [early],
        taxableSupplyDate: "2026-09-02",
        expectedTotalAmount: 453_750,
      }),
    );
    expect(await readInvoice(id)).toMatchObject({
      taxableSupplyDate: "2026-09-02",
      vatAmount: 78_750,
      totalAmount: 453_750,
    });
  });

  test("the reviewed seller stays on the invoice when the default changes before create", async () => {
    const reviewed = await seedSeller("CZ12345678");
    await seedVatRates();
    await setClient({ taxId: "87654321", vatId: "CZ87654321" });
    const entry = await seedEntry("2026-09-02");

    const prefill = await prefillInvoice.handler(
      context(prefillInvoice.handler, {}),
    );
    expect(prefill).toMatchObject({ seller: { id: reviewed } });

    // Another profile becomes the default while the composer is open.
    await db
      .update(sellerProfiles)
      .set({ isDefault: false })
      .where(eq(sellerProfiles.id, reviewed));
    await seedSeller("CZ87654320");

    const id = createdId(
      await create({ timeEntryIds: [entry], sellerProfileId: reviewed }),
    );
    expect(await readInvoice(id)).toMatchObject({ sellerProfileId: reviewed });
  });

  test("a VAT payer without a rate in force on the supply date cannot create an invoice", async () => {
    await seedSeller("CZ12345678");
    await setClient({ taxId: "87654321", vatId: "CZ87654321" });
    const entry = await seedEntry("2026-09-02");

    const refused = await create({
      timeEntryIds: [entry],
      taxableSupplyDate: "2026-09-02",
    });
    expect(refused).toMatchObject({
      code: 409,
      response: { code: "vat_rate_missing" },
    });
    expect(
      await db.query.timeEntries.findFirst({ where: { id: { eq: entry } } }),
    ).toMatchObject({ status: "approved", invoiceId: null });
  });
});
