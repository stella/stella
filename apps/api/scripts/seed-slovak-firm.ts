import { panic } from "better-result";
import { eq, sql } from "drizzle-orm";

import { VAT_RATE_PRESETS } from "@stll/invoicing";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  billingArrangements,
  contacts,
  entities,
  expenses,
  featureEnrolments,
  invoiceLines,
  invoicePayments,
  invoices,
  numberSeries,
  numberSeriesAllocations,
  numberSeriesCounters,
  organizationSettings,
  rateEntries,
  rateTables,
  sellerProfiles,
  timeEntries,
  timeTimers,
  vatRates,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { toNumberPatternScopeKey } from "@/api/lib/billing/number-pattern";
import { toSafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { cents } from "@/api/lib/money";
import { requireLocalDevOpen } from "@/api/runtime-mode";

import {
  buildSlovakFirmSeed,
  SLOVAK_SEED_PEOPLE,
} from "./seed-slovak-firm.data";
import { seedId } from "./seed-utils";

type SeedSlovakFirmOptions = {
  db: { transaction: <T>(run: (tx: Transaction) => Promise<T>) => Promise<T> };
  primaryUserId: string;
  now: Date;
};

/** Separate defaults preserve the Czech scenario and make org switching explicit. */
export const seedSlovakFirm = async ({
  db,
  primaryUserId,
  now,
}: SeedSlovakFirmOptions) => {
  requireLocalDevOpen("Seeding Slovak firm");
  const fixture = buildSlovakFirmSeed(now);
  const { organizationId } = fixture;
  const { ensureMembershipExists, ensureOrganizationExists, ensureUserExists } =
    await import("./seed-test-user");
  await ensureOrganizationExists(organizationId);
  for (const person of SLOVAK_SEED_PEOPLE) {
    const userId = await ensureUserExists(person);
    await ensureMembershipExists({ organizationId, userId, role: person.role });
  }
  await ensureMembershipExists({
    organizationId,
    userId: primaryUserId,
    role: "owner",
  });
  await withAggregateTransaction(db, async (tx) =>
    persistSlovakFirmSeed(tx, { fixture, primaryUserId }),
  );
};

type PersistSlovakFirmSeedOptions = {
  fixture: ReturnType<typeof buildSlovakFirmSeed>;
  primaryUserId: string;
};

export const persistSlovakFirmSeed = async (
  tx: Transaction,
  { fixture, primaryUserId }: PersistSlovakFirmSeedOptions,
) => {
  const { organizationId } = fixture;

  await tx
    .update(organization)
    .set({ name: fixture.seller.legalName, slug: "fictional-slovak-firm" })
    .where(eq(organization.id, organizationId));
  for (const userId of [
    primaryUserId,
    ...SLOVAK_SEED_PEOPLE.map((person) => person.id),
  ]) {
    await tx
      .insert(featureEnrolments)
      .values({
        organizationId,
        userId: toSafeId<"user">(userId),
        featureId: "time-billing",
      })
      .onConflictDoNothing();
  }
  await tx.execute(
    sql`SELECT set_config('role', 'stella', true), set_config('app.organization_id', ${organizationId}, true), set_config('app.user_id', ${primaryUserId}, true), set_config('app.workspace_access_mode', 'explicit', true), set_config('app.workspace_ids', ${`{${fixture.matters.map(({ id }) => id).join(",")}}`}, true)`,
  );
  // Only unbilled fixture time refreshes its dates. Replay preserves issued
  // documents and workflow changes made while rehearsing the scenario.
  await tx
    .insert(organizationSettings)
    .values({
      id: seedId<"organizationSettings">("sk-settings"),
      organizationId,
      invoiceLanguage: "sk",
    })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: { invoiceLanguage: "sk" },
    });
  await tx.insert(sellerProfiles).values(fixture.seller).onConflictDoNothing();
  for (const client of fixture.clients) {
    await tx.insert(contacts).values(client).onConflictDoNothing();
  }
  for (const matter of fixture.matters) {
    await tx.insert(workspaces).values(matter).onConflictDoNothing();
    for (const userId of [
      primaryUserId,
      ...SLOVAK_SEED_PEOPLE.map((person) => person.id),
    ]) {
      await tx
        .insert(workspaceMembers)
        .values({
          id: seedId<"workspaceMember">(`sk-member-${matter.id}-${userId}`),
          workspaceId: matter.id,
          userId,
        })
        .onConflictDoNothing();
    }
    const rateTableId = seedId<"rateTable">(`sk-rate-table-${matter.id}`);
    const client = fixture.clients.find(({ id }) => id === matter.clientId);
    await tx
      .insert(rateTables)
      .values({
        id: rateTableId,
        organizationId,
        workspaceId: matter.id,
        name: "Dohodnuté hodinové sadzby",
        currency: "EUR",
        isDefault: true,
      })
      .onConflictDoNothing();
    const rate = {
      id: seedId<"rateEntry">(`sk-rate-${matter.id}`),
      workspaceId: matter.id,
      rateTableId,
      hourlyRate:
        client?.defaultHourlyRate ?? panic("Missing Slovak client rate"),
      effectiveFrom: fixture.previousMonday,
    };
    await tx.insert(rateEntries).values(rate).onConflictDoNothing();
  }
  for (const arrangement of fixture.arrangements) {
    await tx
      .insert(billingArrangements)
      .values(arrangement)
      .onConflictDoNothing();
  }
  await persistSlovakBillingRecords(tx, fixture);
};

const persistSlovakBillingRecords = async (
  tx: Transaction,
  fixture: ReturnType<typeof buildSlovakFirmSeed>,
) => {
  const { organizationId } = fixture;
  const seriesId = seedId<"numberSeries">("sk-invoice-series");
  await tx
    .insert(numberSeries)
    .values({
      id: seriesId,
      organizationId,
      sellerProfileId: fixture.seller.id,
      documentType: "invoice",
      name: "Faktúry",
      pattern: "SK-{YYYY}-{SEQ}",
      padding: 4,
      isDefault: true,
    })
    .onConflictDoNothing();
  for (const preset of VAT_RATE_PRESETS.SK) {
    const row = {
      ...preset,
      id: seedId<"vatRate">(`sk-vat-${preset.code}-${preset.validFrom}`),
      organizationId,
    };
    await tx.insert(vatRates).values(row).onConflictDoNothing();
  }
  for (const invoice of fixture.invoiceRows) {
    await tx.insert(invoices).values(invoice).onConflictDoNothing();
    if (invoice.invoiceNumber && invoice.finalizedAt) {
      await tx
        .insert(numberSeriesAllocations)
        .values({
          organizationId,
          seriesId,
          documentType: "invoice",
          number: invoice.invoiceNumber,
          issuedAt: invoice.finalizedAt,
        })
        .onConflictDoNothing();
      await tx
        .insert(numberSeriesCounters)
        .values({
          organizationId,
          seriesId,
          periodKey: toNumberPatternScopeKey({
            pattern: "SK-{YYYY}-{SEQ}",
            now: invoice.finalizedAt,
            timeZone: "UTC",
          }),
          lastValue: 1,
        })
        .onConflictDoUpdate({
          target: [
            numberSeriesCounters.seriesId,
            numberSeriesCounters.periodKey,
          ],
          set: {
            lastValue: sql`greatest(${numberSeriesCounters.lastValue}, 1)`,
          },
        });
    }
  }
  for (const entry of fixture.time) {
    await tx
      .insert(timeEntries)
      .values(entry)
      .onConflictDoUpdate({
        target: timeEntries.id,
        set: {
          dateWorked: entry.dateWorked,
          approvedAt: entry.approvedAt,
          returnedAt: entry.returnedAt,
        },
        setWhere: sql`${timeEntries.invoiceId} IS NULL AND ${timeEntries.status} = ${entry.status} AND ${timeEntries.approvedByUserId} IS NOT DISTINCT FROM ${entry.approvedByUserId} AND ${timeEntries.returnedByUserId} IS NOT DISTINCT FROM ${entry.returnedByUserId}`,
      });
  }
  for (const line of fixture.lines) {
    await tx.insert(invoiceLines).values(line).onConflictDoNothing();
  }
  await tx
    .insert(invoicePayments)
    .values(fixture.payment)
    .onConflictDoNothing();
  await tx.execute(
    sql`SELECT set_config('app.user_id', ${fixture.timer.userId}, true)`,
  );
  await tx.insert(timeTimers).values(fixture.timer).onConflictDoNothing();
  const matter =
    fixture.matters.at(0) ?? panic("Missing Slovak expense matter");
  const entityId = seedId<"entity">("sk-expense-context");
  await tx
    .insert(entities)
    .values({
      id: entityId,
      workspaceId: matter.id,
      kind: "folder",
      name: "Podklady k výdavkom",
      displayName: "Podklady k výdavkom",
    })
    .onConflictDoNothing();
  const expense = {
    id: seedId<"expense">("sk-approved-expense"),
    organizationId,
    workspaceId: matter.id,
    matterId: entityId,
    userId: SLOVAK_SEED_PEOPLE[0].id,
    dateIncurred: fixture.previousMonday,
    amount: cents(2450),
    currency: "EUR",
    category: "travel",
    description: "Cestovné na rokovanie s klientom",
    billable: true,
    status: "approved",
  } as const;
  await tx.insert(expenses).values(expense).onConflictDoNothing();
};
