import { expect, test } from "bun:test";

import { explainStartupRefusal } from "./migration-rehearsal-startup-refusal";

const ledgerBefore = "0001_base\n0002_served\n";
const ledgerAfter = "0001_base\n0002_served\n0004_contract\n0003_expand\n";

test.each([
  {
    log: "Panic: Online repair case_law_population_seed introduced by 0002_served is not complete: checkpoint pending\n      at walk (server.js:1:1)",
    check:
      "online migration validation, which refuses a pending online step introduced by a migration older",
    refusal:
      'refused with "Online repair case_law_population_seed introduced by 0002_served is not complete: checkpoint pending"',
  },
  {
    log: "error: Online index idx_x owned by corpus-index is not complete: not built",
    check: "pending code-owned online step",
    refusal: "Online index idx_x owned by corpus-index is not complete",
  },
  {
    log: "Panic: Required migration index idx_documents_matter is missing",
    check: "online index validation",
    refusal: "Required migration index idx_documents_matter is missing",
  },
  {
    log: 'BetterAuthOAuthPolicyCensusError: Better Auth OAuth policy migration is incomplete\n  failedChecks: [ "resources_match" ],',
    check: "the Better Auth OAuth policy census",
    refusal: '(failed checks: "resources_match")',
  },
  {
    log: '{"level":"info","message":"startup.database_login_posture"}\nTypeError: Cannot read properties of undefined',
    check: "an unclassified startup step",
    refusal: "TypeError: Cannot read properties of undefined",
  },
  {
    log: '{"level":"info","message":"server listening"}',
    check: "without a refusal in its log",
    refusal: "without a refusal in its log",
  },
])("names the refusing startup check: $check", ({ log, check, refusal }) => {
  const explanation = explainStartupRefusal({ log, ledgerBefore, ledgerAfter });
  expect(explanation).toContain(check);
  expect(explanation).toContain(refusal);
  expect(explanation).toContain(
    "migrations this checkout applied over it: 0003_expand, 0004_contract (newest 0004_contract)",
  );
});

test("an upgrade that applied no migrations says so", () => {
  expect(
    explainStartupRefusal({
      log: "",
      ledgerBefore,
      ledgerAfter: ledgerBefore,
    }),
  ).toContain("this checkout applied no migrations over it");
});
