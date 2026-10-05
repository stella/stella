import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";
import { parseTimeZoneId, Temporal } from "@stll/time";
import type { TimeZoneId } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { BILLING_STATUS } from "@/api/db/schema";
import type { PracticeJurisdiction } from "@/api/db/schema";
import { updateOrganizationSettingsHandler } from "@/api/handlers/organization-settings/update";
import { exportLedesHandler } from "@/api/handlers/time-entries/ledes/export";
import { exportPdfHandler } from "@/api/handlers/time-entries/pdf/export";
import { toSafeId } from "@/api/lib/branded-types";
import { daysUntilDate } from "@/api/lib/scouts/work-attention.logic";
import { resolveWorkAsOf } from "@/api/lib/work-obligations/at-risk";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// Every path that decides "which day is it" for an organization must answer
// with the calendar day in the organization's zone, including the hours after
// local midnight when the UTC day is still the previous (or already the next)
// one, and on DST transition days.

const ZONES = [
  "UTC",
  "Europe/Prague",
  "America/New_York",
  "America/Los_Angeles",
  "America/St_Johns",
  "Pacific/Auckland",
  "Australia/Lord_Howe",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Pacific/Kiritimati",
  "Pacific/Pago_Pago",
] as const;

const zoneId = (zone: string): TimeZoneId =>
  parseTimeZoneId(zone) ?? panic(`Runtime does not know ${zone}`);

const organizationId = toSafeId<"organization">("org_property");
const workspaceId = toSafeId<"workspace">("ws_property");

// Independent oracle: ICU's calendar fields for the zone, not Temporal.
const oracleFormats = new Map<string, Intl.DateTimeFormat>();
const localDateOracle = (zone: string, epochMilliseconds: number): string => {
  let format = oracleFormats.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      calendar: "gregory",
      day: "2-digit",
      month: "2-digit",
      numberingSystem: "latn",
      timeZone: zone,
      year: "numeric",
    });
    oracleFormats.set(zone, format);
  }
  const parts = new Map(
    format
      .formatToParts(epochMilliseconds)
      .map((part) => [part.type, part.value] as const),
  );
  return `${parts.get("year") ?? "?"}-${parts.get("month") ?? "?"}-${parts.get("day") ?? "?"}`;
};

type Moment = { zone: TimeZoneId; at: Temporal.Instant; oracle: string };

/**
 * An instant within two hours of a local midnight (the first of a month half
 * of the time, where a lock month closes), or within two hours of one of the
 * zone's offset transitions.
 */
const moment: fc.Arbitrary<Moment> = fc
  .record({
    zone: fc.constantFrom(...ZONES),
    year: fc.integer({ min: 1995, max: 2039 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.oneof(fc.constant(1), fc.integer({ min: 1, max: 28 })),
    minutes: fc.integer({ min: -120, max: 120 }),
    nearTransition: fc.boolean(),
  })
  .map(({ zone, year, month, day, minutes, nearTransition }) => {
    const midnight = Temporal.PlainDate.from({ year, month, day })
      .toZonedDateTime({ timeZone: zone })
      .toInstant();
    const transition = nearTransition
      ? midnight
          .toZonedDateTimeISO(zone)
          .getTimeZoneTransition("next")
          ?.toInstant()
      : undefined;
    const at = (transition ?? midnight).add({ minutes });
    return {
      zone: zoneId(zone),
      at,
      oracle: localDateOracle(zone, at.epochMilliseconds),
    };
  });

const timeEntryRow = {
  id: toSafeId<"timeEntry">("te_1"),
  activityGroup: "client",
  userId: "user_1",
  dateWorked: "2026-06-14",
  durationMinutes: 60,
  billedMinutes: 60,
  rateAtEntry: 10_000,
  currency: "USD",
  narrative: "Work",
  invoiceNarrative: null,
  billable: true,
  noCharge: false,
  status: BILLING_STATUS.APPROVED,
  taskCode: null,
  activityCode: null,
};

/** The export's first read answers with the rows and the organization's zone. */
const exportScopedDb = (zone: TimeZoneId): ScopedDb => {
  let call = 0;
  return asTestRaw<ScopedDb>(async () => {
    call += 1;
    return call === 1
      ? { rows: [timeEntryRow], timeZone: zone }
      : [{ id: "user_1", name: "Alice" }];
  });
};

type SettingsRow = {
  timeZone: TimeZoneId | null;
  practiceJurisdictions: PracticeJurisdiction[];
};

/** A transaction whose settings reads return `row`; writes are accepted. */
const settingsTx = (row: SettingsRow) => {
  const rows = [row];
  // Awaiting the array yields the rows; `.for("update")` is the locked read.
  const limited = Object.assign([...rows], { for: async () => rows });
  return asTestRaw<Transaction>({
    select: () => ({
      from: () => ({ where: () => ({ limit: () => limited }) }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: async () => {},
        onConflictDoUpdate: async () => {},
      }),
    }),
  });
};

const settingsDb =
  (row: SettingsRow): SafeDb =>
  async (operation) =>
    Result.ok(await operation(settingsTx(row)));

const lastDayOfMonth = (date: Temporal.PlainDate) =>
  date.with({ day: date.daysInMonth });

describe("organization day (properties)", () => {
  test(
    "the lock-month check closes a month once the organization's day has left it",
    async () => {
      await assertProperty(
        "the lock-month check closes a month once the organization's day has left it",
        fc.asyncProperty(
          moment,
          fc.boolean(),
          async ({ zone, at, oracle }, previous) => {
            const today = Temporal.PlainDate.from(oracle);
            const lockedThrough = lastDayOfMonth(
              previous ? today.subtract({ days: 1 }) : today,
            );
            const result = await Result.gen(() =>
              updateOrganizationSettingsHandler({
                body: { timeLockedThroughMonth: lockedThrough.toString() },
                organizationId,
                recordAuditEvent: async () => {},
                safeDb: settingsDb({
                  timeZone: zone,
                  practiceJurisdictions: [],
                }),
                now: at,
              }),
            );
            const closed = Temporal.PlainDate.compare(lockedThrough, today) < 0;
            expect(Result.isOk(result)).toBe(closed);
          },
        ),
      );
    },
    propertyTestTimeout(20_000),
  );

  test(
    "the LEDES invoice is dated on the organization's day",
    async () => {
      await assertProperty(
        "the LEDES invoice is dated on the organization's day",
        fc.asyncProperty(moment, async ({ zone, at, oracle }) => {
          const result = await exportLedesHandler({
            scopedDb: exportScopedDb(zone),
            workspaceId,
            organizationId,
            query: {},
            at,
          });
          const ledes = result.unwrap();
          const invoiceDate = ledes.split("\n").at(2)?.split("|").at(0);
          expect(invoiceDate).toBe(oracle.replaceAll("-", ""));
        }),
      );
    },
    propertyTestTimeout(20_000),
  );

  test(
    "the PDF timesheet is generated on the organization's day",
    async () => {
      await assertProperty(
        "the PDF timesheet is generated on the organization's day",
        fc.asyncProperty(moment, async ({ zone, at, oracle }) => {
          const pdf = await exportPdfHandler({
            scopedDb: exportScopedDb(zone),
            workspaceId,
            organizationId,
            query: {},
            at,
          });
          expect(new TextDecoder().decode(pdf)).toContain(
            `Generated: ${oracle}`,
          );
        }),
      );
    },
    propertyTestTimeout(20_000),
  );

  test(
    "work without an asOf is due on the organization's day",
    async () => {
      await assertProperty(
        "work without an asOf is due on the organization's day",
        fc.asyncProperty(moment, async ({ zone, at, oracle }) => {
          const asOf = await resolveWorkAsOf({
            asOf: undefined,
            safeDb: settingsDb({ timeZone: zone, practiceJurisdictions: [] }),
            organizationId,
            at,
          });
          expect(asOf.unwrap()).toBe(oracle);
        }),
      );
    },
    propertyTestTimeout(20_000),
  );

  test(
    "the attention scout counts deadline days from the organization's day",
    () => {
      assertProperty(
        "the attention scout counts deadline days from the organization's day",
        fc.property(
          moment,
          fc.integer({ min: -3, max: 3 }),
          ({ zone, at, oracle }, shift) => {
            const date = Temporal.PlainDate.from(oracle)
              .add({ days: shift })
              .toString();
            const now = new Date(at.epochMilliseconds);
            expect(daysUntilDate({ date, now, zone })).toBe(shift);
          },
        ),
      );
    },
    propertyTestTimeout(20_000),
  );

  test(
    "an organization without a stored zone takes its primary jurisdiction's day",
    async () => {
      await assertProperty(
        "an organization without a stored zone takes its primary jurisdiction's day",
        fc.asyncProperty(
          moment,
          fc.constantFrom("CZ", "SK", "DE", "US", "GB", "PL"),
          async ({ at }, countryCode) => {
            const asOf = await resolveWorkAsOf({
              asOf: undefined,
              safeDb: settingsDb({
                timeZone: null,
                practiceJurisdictions: [
                  { countryCode: "AT", isPrimary: false },
                  { countryCode, isPrimary: true },
                ],
              }),
              organizationId,
              at,
            });
            const expectedZone =
              countryCode === "CZ" || countryCode === "SK"
                ? "Europe/Prague"
                : "UTC";
            expect(asOf.unwrap()).toBe(
              localDateOracle(expectedZone, at.epochMilliseconds),
            );
          },
        ),
      );
    },
    propertyTestTimeout(20_000),
  );
});
