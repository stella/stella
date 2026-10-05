import { panic, Result } from "better-result";
import { describe, expect, mock, spyOn, test } from "bun:test";

import type { CountryCode } from "@stll/country-codes";

import type { ScopedDb } from "@/api/db/safe-db";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import type {
  BusinessRegistryHit,
  executeRegistryLookup,
} from "@/api/lib/business-registries/dispatch";
import {
  personDateOfBirth,
  runEntityCheckShared,
} from "@/api/lib/business-registries/entity-checks";
import { runSanctionsCheck } from "@/api/lib/business-registries/sanctions-check";
import type { SanctionsCheckDependencies } from "@/api/lib/business-registries/sanctions-check";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  screenSanctionsSubject,
  SanctionsScreening,
} from "@/api/lib/lists/sanctions/screening-service";
import { SanctionsSubjectError } from "@/api/lib/lists/sanctions/screening-service";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";

// The register, the lists and the firm's settings are all replaced: these
// tests pin how a subject becomes a name to screen, and what happens when it
// cannot.

const permit = grantThirdPartyOutboundPermit();

const noDatabase: ScopedDb = async () =>
  panic("This test must not reach the database");

const CLEAR_SCREENING: SanctionsScreening = {
  status: "clear",
  checkedAt: "2026-09-29T08:00:00.000Z",
  cutoff: 0.8,
  lists: [],
};

const aresHit = (id: string, name: string): BusinessRegistryHit => ({
  registry: "ares",
  id,
  name,
  legalForm: null,
  address: null,
  registryUrl: `https://ares.gov.cz/ekonomicke-subjekty?ico=${id}`,
});

const dependencies = ({
  executeLookup,
  screen = mock<typeof screenSanctionsSubject>(async () =>
    Result.ok(CLEAR_SCREENING),
  ),
  jurisdictions = ["CZ"],
}: {
  executeLookup?: typeof executeRegistryLookup;
  screen?: typeof screenSanctionsSubject;
  jurisdictions?: CountryCode[];
}): SanctionsCheckDependencies => ({
  observer: "unobserved",
  permit,
  scopedDb: noDatabase,
  organizationId: toSafeId<"organization">("org_1"),
  executeLookup:
    executeLookup ?? (async () => panic("This test must not read a register")),
  screen,
  loadPracticeJurisdictions: async () => jurisdictions,
});

describe("sanctions check", () => {
  test("screens a company ID under the name its register gives", async () => {
    const executeLookup = mock<typeof executeRegistryLookup>(
      async ({ handler }) => ({
        type: "lookup",
        registry: handler.slug,
        hit: aresHit("26863154", "Správa pohledávek OKD, a.s."),
      }),
    );
    const screen = mock<typeof screenSanctionsSubject>(async () =>
      Result.ok(CLEAR_SCREENING),
    );
    const observer = { onRequest: () => undefined, onError: () => undefined };
    const result = await runSanctionsCheck({
      subject: { type: "company-id", value: " 26863154 ", country: "CZ" },
      dependencies: { ...dependencies({ executeLookup, screen }), observer },
    });

    expect(executeLookup.mock.calls.at(0)?.at(0)).toMatchObject({
      handler: { slug: "ares" },
      query: "26863154",
    });
    expect(executeLookup.mock.calls.at(0)?.at(0)?.observer).toBe(observer);
    expect(screen.mock.calls.at(0)?.at(0)).toMatchObject({
      subject: {
        type: "organization",
        name: "Správa pohledávek OKD, a.s.",
        identifiers: ["26863154"],
      },
      practiceJurisdictions: ["CZ"],
    });
    expect(result.unwrap()).toMatchObject({
      kind: "sanctions",
      status: "clear",
      subject: {
        type: "organization",
        name: "Správa pohledávek OKD, a.s.",
        resolvedFrom: {
          type: "company-id",
          value: "26863154",
          country: "CZ",
          registry: "ares",
        },
      },
    });
  });

  test("register names bypass free-text limits and uncorrectable names return unavailable", async () => {
    const name = Array.from({ length: 30 }, (_, index) => `Word${index}`).join(
      " ",
    );
    const executeLookup = mock<typeof executeRegistryLookup>(
      async ({ handler }) => ({
        type: "lookup",
        registry: handler.slug,
        hit: aresHit("26863154", name),
      }),
    );
    const screen = mock<typeof screenSanctionsSubject>(async () =>
      Result.err(
        new SanctionsSubjectError({
          code: "empty-query",
          message: "the register name could not be screened",
        }),
      ),
    );
    const result = await runSanctionsCheck({
      subject: { type: "company-id", value: "26863154", country: "CZ" },
      dependencies: dependencies({ executeLookup, screen }),
    });
    expect(screen.mock.calls.at(0)?.at(0)).toMatchObject({
      nameSource: "register",
      subject: { name },
    });
    expect(result.isOk()).toBe(true);
    expect(result.unwrap().status).toBe("unavailable");
    expect(
      result.unwrap().lists.every((list) => list.status === "unavailable"),
    ).toBe(true);
  });

  test("reads a Slovak company ID from its own register", async () => {
    const executeLookup = mock<typeof executeRegistryLookup>(
      async ({ handler }) => ({
        type: "lookup",
        registry: handler.slug,
        hit: {
          ...aresHit("35757442", "Slovak Example s.r.o."),
          registry: "rpo",
        },
      }),
    );
    await runSanctionsCheck({
      subject: { type: "company-id", value: "35757442", country: "SK" },
      dependencies: dependencies({ executeLookup }),
    });
    expect(executeLookup.mock.calls.at(0)?.at(0)).toMatchObject({
      handler: { slug: "rpo" },
    });
  });

  test.each([
    {
      name: "the register holds no such company",
      answer: async () => ({
        type: "lookup" as const,
        registry: "ares" as const,
        hit: null,
      }),
      reason: "company-not-found",
    },
    {
      name: "the register fails",
      answer: async () =>
        new HandlerError({
          status: 502,
          message: "Registry 'ares' lookup failed",
        }),
      reason: "registry-unavailable",
    },
  ])(
    "reports every list unavailable, never clear, when $name",
    async ({ answer, reason }) => {
      const screen = mock<typeof screenSanctionsSubject>(async () =>
        Result.ok(CLEAR_SCREENING),
      );
      const result = await runSanctionsCheck({
        subject: { type: "company-id", value: "26863154", country: "CZ" },
        dependencies: dependencies({ executeLookup: answer, screen }),
      });
      const check = result.unwrap();
      expect(screen).not.toHaveBeenCalled();
      expect(check.status).toBe("unavailable");
      expect(check.subject).toEqual({
        type: "company-id",
        value: "26863154",
        country: "CZ",
      });
      expect(check.lists.map((list) => list.source).toSorted()).toEqual(
        sanctionsSourceIds().toSorted(),
      );
      for (const list of check.lists) {
        expect(list).toMatchObject({
          status: "unavailable",
          reason,
          editionId: null,
          possibleMatches: [],
        });
      }
      // The labels still come from the firm's jurisdictions.
      expect(
        check.lists.find((list) => list.source === "eu")?.classification,
      ).toBe("binding");
    },
  );

  test("asks for a valid company ID when the register refuses the one given", async () => {
    const screen = mock<typeof screenSanctionsSubject>(async () =>
      Result.ok(CLEAR_SCREENING),
    );
    const result = await runSanctionsCheck({
      // Eight digits, but the checksum fails at the register.
      subject: { type: "company-id", value: "26863155", country: "CZ" },
      dependencies: dependencies({
        executeLookup: async () =>
          new HandlerError({ status: 400, message: "Invalid IČO checksum" }),
        screen,
      }),
    });
    expect(screen).not.toHaveBeenCalled();
    expect(result.isErr() && result.error).toMatchObject({
      status: 400,
      code: "validation_error",
      message: "Company ID must be a valid Czech IČO (8 digits)",
      hint: expect.stringContaining("organization"),
    });
  });

  test.each([
    { name: "not configured", status: 428 as const },
    { name: "rate limited", status: 429 as const },
    { name: "down", status: 503 as const },
    { name: "failing upstream", status: 502 as const },
  ])(
    "reports the lists unavailable when the register is $name",
    async ({ status }) => {
      const result = await runSanctionsCheck({
        subject: { type: "company-id", value: "26863154", country: "CZ" },
        dependencies: dependencies({
          executeLookup: async () =>
            new HandlerError({ status, message: "Register did not answer" }),
        }),
      });
      const check = result.unwrap();
      expect(check.status).toBe("unavailable");
      for (const list of check.lists) {
        expect(list.reason).toBe("registry-unavailable");
      }
    },
  );

  test("reports the lists unavailable when the ID check itself fails", async () => {
    const isCanonicalId = spyOn(
      BUSINESS_REGISTRY_DISPATCH.ares,
      "isCanonicalId",
    ).mockImplementation(() => {
      throw new Error("checksum binding failed");
    });
    try {
      const result = await runSanctionsCheck({
        subject: { type: "company-id", value: "26863154", country: "CZ" },
        dependencies: dependencies({}),
      });
      const check = result.unwrap();
      expect(check.status).toBe("unavailable");
      for (const list of check.lists) {
        expect(list.reason).toBe("registry-unavailable");
      }
    } finally {
      isCanonicalId.mockRestore();
    }
  });

  test("asks for a valid company ID before reading any register", async () => {
    const result = await runSanctionsCheck({
      subject: { type: "company-id", value: "12AB", country: "CZ" },
      dependencies: dependencies({}),
    });
    expect(result.isErr() && result.error).toMatchObject({
      status: 400,
      code: "validation_error",
      message: "Company ID must be a valid Czech IČO (8 digits)",
    });
  });

  test("screens a person with the date and nationalities known", async () => {
    const screen = mock<typeof screenSanctionsSubject>(async () =>
      Result.ok(CLEAR_SCREENING),
    );
    const result = await runSanctionsCheck({
      subject: {
        type: "person",
        firstName: " Ivan ",
        lastName: "Sidorov",
        dateOfBirth: { precision: "month", year: 1960, month: 5 },
        nationalityCodes: ["RU", "RU", "BY"],
      },
      dependencies: dependencies({ screen }),
    });
    expect(screen.mock.calls.at(0)?.at(0)?.subject).toEqual({
      type: "person",
      name: "Ivan Sidorov",
      birthDate: { year: 1960, month: 5 },
      nationalityCodes: ["RU", "BY"],
    });
    expect(result.unwrap().subject).toEqual({
      type: "person",
      name: "Ivan Sidorov",
      dateOfBirth: { precision: "month", year: 1960, month: 5 },
      nationalityCodes: ["RU", "BY"],
    });
  });

  test("screens an organization by name with its company ID as an identifier", async () => {
    const screen = mock<typeof screenSanctionsSubject>(async () =>
      Result.ok(CLEAR_SCREENING),
    );
    await runSanctionsCheck({
      subject: {
        type: "organization",
        name: "Acme Trading",
        companyId: "123 45 678",
      },
      dependencies: dependencies({ screen }),
    });
    expect(screen.mock.calls.at(0)?.at(0)?.subject).toEqual({
      type: "organization",
      name: "Acme Trading",
      identifiers: ["123 45 678"],
    });
  });
});

describe("counterparty check subject routing", () => {
  const sanctions = { ...dependencies({}), runSanctionsCheck };
  const neverRunCheck = async () => panic("The register must not be asked");

  test("refuses a tax ID for the sanctions check and names the subjects it takes", async () => {
    const result = await runEntityCheckShared({
      observer: "unobserved",
      permit,
      check: "sanctions",
      subject: { type: "tax-id", value: "CZ45274649" },
      runCheck: neverRunCheck,
      sanctions,
    });
    expect(result.isErr() && result.error).toMatchObject({
      status: 400,
      code: "validation_error",
      hint: expect.stringContaining("company-id"),
    });
  });

  test.each([
    {
      name: "a person without a full birth date",
      subject: {
        type: "person" as const,
        firstName: "Jan",
        lastName: "Novák",
        dateOfBirth: { precision: "year" as const, year: 1980 },
        nationalityCodes: [],
      },
      message: "The cz-insolvency check needs the person's full birth date",
    },
    {
      name: "a Slovak company ID",
      subject: {
        type: "company-id" as const,
        value: "35757442",
        country: "SK" as const,
      },
      message: "The cz-insolvency check covers Czech companies only",
    },
    {
      name: "an organization named without its ID",
      subject: {
        type: "organization" as const,
        name: "Acme Trading",
        companyId: null,
      },
      message: "The cz-insolvency check does not take an organization by name",
    },
    {
      // Its registration number carries no country, so it is never read as
      // a Czech company ID.
      name: "an organization named with a registration number",
      subject: {
        type: "organization" as const,
        name: "Slovak Example s.r.o.",
        companyId: "35757442",
      },
      message: "The cz-insolvency check does not take an organization by name",
    },
  ])(
    "asks the caller to correct $name for a register check",
    async ({ subject, message }) => {
      const result = await runEntityCheckShared({
        observer: "unobserved",
        permit,
        check: "cz-insolvency",
        subject,
        runCheck: neverRunCheck,
        sanctions,
      });
      expect(result.isErr() && result.error).toMatchObject({
        status: 400,
        code: "validation_error",
        message,
      });
    },
  );

  test("does not ask for a birth date the VAT check would not use", async () => {
    const result = await runEntityCheckShared({
      observer: "unobserved",
      permit,
      check: "cz-vat-reliability",
      subject: {
        type: "person",
        firstName: "Jan",
        lastName: "Novák",
        dateOfBirth: null,
        nationalityCodes: [],
      },
      runCheck: neverRunCheck,
      sanctions,
    });
    const error = result.isErr() ? result.error : null;
    expect(error).toMatchObject({
      status: 400,
      message: "The cz-vat-reliability check does not screen persons",
    });
    expect(error?.hint).not.toContain("birth date");
  });
});

describe("person birth date", () => {
  test.each([
    { name: "a full date", birthDate: "1990-02-31", dateOfBirth: undefined },
    {
      name: "a day-precision date of birth",
      birthDate: undefined,
      dateOfBirth: {
        precision: "day" as const,
        year: 1990,
        month: 2,
        day: 31,
      },
    },
  ])(
    "refuses $name that is not in the calendar",
    ({ birthDate, dateOfBirth }) => {
      const result = personDateOfBirth({ birthDate, dateOfBirth });
      expect(result.isErr() && result.error).toMatchObject({
        status: 400,
        code: "validation_error",
        message: "The birth date is not a valid calendar date",
      });
    },
  );

  test("reads a leap day", () => {
    expect(
      personDateOfBirth({
        birthDate: undefined,
        dateOfBirth: { precision: "day", year: 1988, month: 2, day: 29 },
      }).unwrap(),
    ).toEqual({ precision: "day", year: 1988, month: 2, day: 29 });
  });

  test.each([
    { precision: "year" as const, year: 1960 },
    { precision: "month" as const, year: 1960, month: 5 },
    { precision: "day" as const, year: 1960, month: 5, day: 12 },
  ])(
    "takes the full date beside a $precision-precision date that agrees",
    (dateOfBirth) => {
      expect(
        personDateOfBirth({ birthDate: "1960-05-12", dateOfBirth }).unwrap(),
      ).toEqual({ precision: "day", year: 1960, month: 5, day: 12 });
    },
  );

  test.each([
    { precision: "year" as const, year: 1961 },
    { precision: "month" as const, year: 1960, month: 6 },
    { precision: "day" as const, year: 1960, month: 5, day: 13 },
  ])(
    "refuses a $precision-precision date that contradicts the full date",
    (dateOfBirth) => {
      const result = personDateOfBirth({
        birthDate: "1960-05-12",
        dateOfBirth,
      });
      expect(result.isErr() && result.error).toMatchObject({
        message:
          "The full birth date and the date of birth name different dates",
      });
    },
  );
});
