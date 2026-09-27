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

import { ChatToolError } from "@/api/lib/errors/tagged-errors";

import {
  COUNTERPARTY_CHECK_TOOL_NAME,
  createCounterpartyCheckTools,
} from "./counterparty-check-tools.js";

const executeWith = (runCheck: typeof runEntityCheck) => {
  const tool = createCounterpartyCheckTools({ runCheck })[
    COUNTERPARTY_CHECK_TOOL_NAME
  ];
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
      subject: { type: "company-id", companyId: "45274649" },
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
        firstName: "Jan",
        lastName: "Novák",
        birthDate: "1980-03-15",
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
      subject: { type: "company-id", companyId: "26863155" },
    }).then(
      () => panic("Expected the tool to fail"),
      (error: unknown) => error,
    );
    expect(ChatToolError.is(failure) && failure.kind).toBe("invalid-input");
  });
});
