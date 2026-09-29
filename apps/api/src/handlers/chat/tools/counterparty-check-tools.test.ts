import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  CZ_INSOLVENCY_SOURCE,
  EntityCheckInputError,
} from "@stll/business-registries/entity-checks";
import type {
  EntityCheckResult,
  runEntityCheck,
} from "@stll/business-registries/entity-checks";

import { toSafeId } from "@/api/lib/branded-types";
import type {
  runSanctionsCheck,
  SanctionsCheckResult,
} from "@/api/lib/business-registries/sanctions-check";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";

import {
  COUNTERPARTY_CHECK_TOOL_NAME,
  createCounterpartyCheckTools,
} from "./counterparty-check-tools.js";

const executeWith = (
  runCheck: typeof runEntityCheck,
  runSanctions?: typeof runSanctionsCheck,
) => {
  const tool = createCounterpartyCheckTools({
    scopedDb: async () => panic("This test must not reach the database"),
    organizationId: toSafeId<"organization">("org_1"),
    runCheck,
    runSanctions,
  })[COUNTERPARTY_CHECK_TOOL_NAME];
  const execute = tool.execute ?? panic("Expected an executable tool");
  return async (input: Parameters<typeof execute>[0]) =>
    await execute(input, { emitCustomEvent: () => undefined });
};

const UNAVAILABLE = {
  status: "unavailable",
  kind: "cz-insolvency",
  source: CZ_INSOLVENCY_SOURCE,
  subject: { type: "company-id", value: "45274649" },
  checkedAt: "2026-09-26T14:00:00Z",
  reason: "timeout",
  detail: null,
} as const satisfies EntityCheckResult;

describe("counterparty_check chat tool", () => {
  test("returns an unavailable source as a result the model reads, not a failure", async () => {
    const execute = executeWith(async () => Result.ok(UNAVAILABLE));
    const result = await execute({
      check: "cz-insolvency",
      subject: { type: "company-id", company_id: "45274649" },
    });
    expect(result).toEqual(UNAVAILABLE);
  });

  test("passes a person subject through to the check", async () => {
    let received: Parameters<typeof runEntityCheck>[0] | undefined;
    const execute = executeWith(async (options) => {
      received = options;
      return Result.ok(UNAVAILABLE);
    });
    await execute({
      check: "cz-insolvency",
      subject: {
        type: "person",
        first_name: "Jan",
        last_name: "Novák",
        birth_date: "1980-03-15",
      },
    });
    expect(received?.subject).toEqual({
      type: "person",
      firstName: "Jan",
      lastName: "Novák",
      birthDate: "1980-03-15",
    });
  });

  test("asks the model to correct a subject the check rejects", async () => {
    const execute = executeWith(async () =>
      Result.err(
        new EntityCheckInputError({
          message: "Company ID must be a valid Czech IČO (8 digits)",
        }),
      ),
    );
    const failure = await execute({
      check: "cz-insolvency",
      subject: { type: "company-id", company_id: "26863155" },
    }).then(
      () => panic("Expected the tool to fail"),
      (error: unknown) => error,
    );
    expect(ChatToolError.is(failure) && failure.kind).toBe("invalid-input");
  });

  test("returns the sanctions lists that could not answer as a result, not a failure", async () => {
    const unavailable: SanctionsCheckResult = {
      kind: "sanctions",
      status: "unavailable",
      subject: { type: "company-id", value: "26863154", country: "CZ" },
      checkedAt: "2026-09-29T08:00:00.000Z",
      cutoff: 0.8,
      lists: [
        {
          source: "eu",
          issuer: "EU",
          issuerName: "European Union",
          classification: "binding",
          status: "unavailable",
          reason: "registry-unavailable",
          checkedAt: "2026-09-29T08:00:00.000Z",
          editionId: null,
          publishedAt: null,
          verifiedAt: null,
          pendingUpdate: null,
          totalMatches: 0,
          truncated: false,
          possibleMatches: [],
        },
      ],
    };
    let received: Parameters<typeof runSanctionsCheck>[0] | undefined;
    const execute = executeWith(
      async () => panic("The register must not be asked"),
      async (options) => {
        received = options;
        return Result.ok(unavailable);
      },
    );
    const result = await execute({
      check: "sanctions",
      subject: {
        type: "person",
        first_name: "Ivan",
        last_name: "Sidorov",
        date_of_birth: { precision: "year", year: 1960 },
        nationality_codes: ["RU"],
      },
    });
    expect(result).toEqual(unavailable);
    expect(received?.subject).toEqual({
      type: "person",
      firstName: "Ivan",
      lastName: "Sidorov",
      dateOfBirth: { precision: "year", year: 1960 },
      nationalityCodes: ["RU"],
    });
  });
});
