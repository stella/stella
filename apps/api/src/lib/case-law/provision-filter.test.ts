import { SQL } from "bun";
import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readCaseLawProvisionScopeWithinBudget } from "@/api/lib/case-law/provision-filter";
import { getPublicReadStatementTimeoutMs } from "@/api/lib/legal-search/public-read-timeout-context";
import { LIMITS } from "@/api/lib/limits";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const scope = {
  jurisdiction: "CZE",
  provision: { work: "141/1961 Sb.", anchor: "par_265b" },
};

const dbAnswering = (answer: () => Promise<unknown>) =>
  asTestRaw<CaseLawPublicReadDb>(answer);

const postgresError = (errno: string) =>
  new SQL.PostgresError("statement failed", {
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno,
    detail: "",
    hint: "",
    severity: "ERROR",
  });

test("a scope read runs under its own statement budget", async () => {
  let budgetMs: number | undefined;
  const answered = await readCaseLawProvisionScopeWithinBudget(
    dbAnswering(async () => {
      budgetMs = getPublicReadStatementTimeoutMs();
      return { type: "decisions", decisionIds: [] };
    }),
    scope,
  );
  expect(budgetMs).toBe(LIMITS.caseLawProvisionScopeStatementBudgetMs);
  expect(answered).toEqual({ type: "decisions", decisionIds: [] });
});

test("a statement its budget cancelled reads as broad", async () => {
  expect(
    await readCaseLawProvisionScopeWithinBudget(
      dbAnswering(async () => await Promise.reject(postgresError("57014"))),
      scope,
    ),
  ).toEqual({ type: "broad" });
});

test("any other failure stays the failure it was", async () => {
  const failure = postgresError("53300");
  expect(
    await rejectionOf(
      readCaseLawProvisionScopeWithinBudget(
        dbAnswering(async () => await Promise.reject(failure)),
        scope,
      ),
    ),
  ).toBe(failure);
});
