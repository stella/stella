import { panic, Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import type {
  BusinessRegistryHit,
  executeRegistryLookup,
} from "@/api/lib/business-registries/dispatch";
import { runEntityCheckShared } from "@/api/lib/business-registries/entity-checks";
import { runSanctionsCheck } from "@/api/lib/business-registries/sanctions-check";
import type { SanctionsCheckDependencies } from "@/api/lib/business-registries/sanctions-check";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  screenSanctionsSubject,
  SanctionsScreening,
} from "@/api/lib/lists/sanctions/screening-service";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";

// The register, the lists and the firm's settings are all replaced: these
// tests pin how a subject becomes a name to screen, and what happens when it
// cannot.

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
  jurisdictions?: string[];
}): SanctionsCheckDependencies => ({
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
    const result = await runSanctionsCheck({
      subject: { type: "company-id", value: " 26863154 ", country: "CZ" },
      dependencies: dependencies({ executeLookup, screen }),
    });

    expect(executeLookup.mock.calls.at(0)?.at(0)).toMatchObject({
      handler: { slug: "ares" },
      query: "26863154",
    });
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
      message:
        "The cz-insolvency check finds a company by its company ID, not its name",
    },
  ])(
    "asks the caller to correct $name for a register check",
    async ({ subject, message }) => {
      const result = await runEntityCheckShared({
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
});
