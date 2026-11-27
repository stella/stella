import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseSource, walk } from "@stll/scripts/src/syntax-tree";

import { listApiTestPaths } from "../../../scripts/api-test-plan";

const apiRoot = path.resolve(import.meta.dir, "../../..");
const SECURITY_TEST_PREFIX = "src/tests/security/";

/**
 * Required adversarial and invariant security suites. Deleting, renaming, or
 * dropping any of these from API test discovery fails this meta-guard so
 * security coverage cannot quietly erode.
 */
export const REQUIRED_SECURITY_SUITES = [
  // Cross-tenant & handler isolation
  "src/tests/security/cross-tenant-handlers.test.ts",
  "src/tests/security/cross-tenant-coverage.test.ts",
  "src/tests/security/cross-member-time-entries.integration.test.ts",
  "src/tests/security/matter-access-census.test.ts",
  "src/tests/security/contacts-owner-scope-census.test.ts",
  "src/tests/security/workspace-route-params.test.ts",
  // MCP & capability boundaries
  "src/tests/security/mcp-adversarial-isolation.db.test.ts",
  "src/tests/security/capability-request-routes.test.ts",
  // RLS & database isolation
  "src/tests/security/rls-negative.test.ts",
  "src/tests/security/rls-positive.test.ts",
  "src/tests/security/rls-coverage.test.ts",
  "src/tests/security/rls-scoped-db.test.ts",
  "src/tests/security/rls-table-grants.test.ts",
  "src/tests/security/ai-memories-rls.test.ts",
  "src/tests/security/user-files-rls.test.ts",
  "src/tests/security/rls-agent-skills.test.ts",
  "src/tests/security/rls-sharepoint.test.ts",
  "src/tests/security/rls-folio-collab-rooms.test.ts",
  "src/tests/security/case-law-research-rls.integration.test.ts",
  "src/tests/security/saved-searches-rls.integration.test.ts",
  // Auth, sessions, credentials & machine API keys
  "src/tests/security/account-wide-auth-revocation.test.ts",
  "src/tests/security/auth-lifecycle.test.ts",
  "src/tests/security/auth-user-grants.test.ts",
  "src/tests/security/route-auth-invariants.test.ts",
  "src/tests/security/raw-route-census.test.ts",
  "src/tests/security/sse-auth-invariants.test.ts",
  "src/tests/security/session-credential-census.test.ts",
  "src/tests/security/session-liveness-census.test.ts",
  "src/tests/security/machine-api-keys.test.ts",
  "src/tests/security/machine-api-key-lifecycle.test.ts",
  "src/tests/security/machine-api-key-member-removal.test.ts",
  "src/tests/security/credential-columns.test.ts",
  "src/tests/security/secret-guardrails.test.ts",
  // Permissions & billing visibility
  "src/tests/security/write-handler-permission-coverage.test.ts",
  "src/tests/security/own-work-permissions.test.ts",
  "src/tests/security/case-law-research-permissions.test.ts",
  "src/tests/security/billing-visibility.test.ts",
  "src/tests/security/billing-arrangements.test.ts",
  "src/tests/security/invoice-send-immutability.test.ts",
  // Ownership, public boundaries & wire/schema invariants
  "src/tests/security/organization-creation-ownership.test.ts",
  "src/tests/security/organization-deletion-entry.test.ts",
  "src/tests/security/organization-file-write-guard.test.ts",
  "src/tests/security/upload-write-ownership.test.ts",
  "src/tests/security/public-law-reader-role.test.ts",
  "src/tests/security/public-law-access-independence.test.ts",
  "src/tests/security/schema-invariants.test.ts",
  "src/tests/security/branded-types.test.ts",
  "src/tests/security/wire-input-schemas.test.ts",
] as const;

/**
 * Security suites gated on a live PostgreSQL instance (`STELLA_RUN_POSTGRES_TESTS=true`).
 * They may carry a single suite-level `describe.skip` or `describe.skipIf` guard
 * tied to `STELLA_RUN_POSTGRES_TESTS`, and never individual `test.skip`/`test.todo`.
 */
const POSTGRES_GATED_SECURITY_SUITES = new Set<string>([
  "src/tests/security/billing-arrangements.postgres.test.ts",
  "src/tests/security/billing-visibility.postgres.test.ts",
  "src/tests/security/case-law-decision-base-table-contract.postgres.test.ts",
  "src/tests/security/public-law-reader-role.postgres.test.ts",
  "src/tests/security/table-policy-settings.test.ts",
]);

const TEST_RUNNER_OBJECTS = new Set(["test", "it", "describe"]);
const DISALLOWED_TEST_MODIFIERS = new Set([
  "skip",
  "todo",
  "only",
  "skipIf",
  "if",
]);
const DISALLOWED_TEST_IDENTIFIERS = new Set([
  "xit",
  "xtest",
  "xdescribe",
  "fit",
  "ftest",
  "fdescribe",
]);
const POSTGRES_GATE_ENV = "STELLA_RUN_POSTGRES_TESTS";

export type DisabledCallFinding = {
  callee: string;
  isSuiteLevelPostgresGateCandidate: boolean;
};

export type SecuritySuiteInspection = {
  disabledCalls: DisabledCallFinding[];
  expectCalls: number;
  testCalls: number;
  referencesPostgresGateEnv: boolean;
};

export const inspectSecuritySuiteSource = (
  filename: string,
  source: string,
): SecuritySuiteInspection => {
  const { program } = parseSource(filename, source);
  const disabledCalls: DisabledCallFinding[] = [];
  let expectCalls = 0;
  let testCalls = 0;

  walk(program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const callee = node.callee;
    if (callee.type === "Identifier") {
      if (callee.name === "expect") {
        expectCalls += 1;
      } else if (callee.name === "test" || callee.name === "it") {
        testCalls += 1;
      } else if (DISALLOWED_TEST_IDENTIFIERS.has(callee.name)) {
        disabledCalls.push({
          callee: callee.name,
          isSuiteLevelPostgresGateCandidate: false,
        });
      }
      return;
    }

    if (callee.type !== "MemberExpression") {
      return;
    }
    if (
      callee.object.type !== "Identifier" ||
      !TEST_RUNNER_OBJECTS.has(callee.object.name)
    ) {
      return;
    }
    let modifier: string | undefined;
    if (callee.property.type === "Identifier") {
      modifier = callee.property.name;
    } else if (
      callee.property.type === "Literal" &&
      typeof callee.property.value === "string"
    ) {
      modifier = callee.property.value;
    }
    if (modifier === undefined) {
      return;
    }
    if (
      modifier === "each" &&
      (callee.object.name === "test" || callee.object.name === "it")
    ) {
      testCalls += 1;
      return;
    }
    if (DISALLOWED_TEST_MODIFIERS.has(modifier)) {
      disabledCalls.push({
        callee: `${callee.object.name}.${modifier}`,
        isSuiteLevelPostgresGateCandidate:
          callee.object.name === "describe" &&
          (modifier === "skip" || modifier === "skipIf"),
      });
    }
  });

  return {
    disabledCalls,
    expectCalls,
    testCalls,
    referencesPostgresGateEnv: source.includes(POSTGRES_GATE_ENV),
  };
};

describe("security wall manifest", () => {
  const discoveredTests = listApiTestPaths(apiRoot);
  const discoveredSet = new Set(discoveredTests);
  const securityTestPaths = discoveredTests.filter((file) =>
    file.startsWith(SECURITY_TEST_PREFIX),
  );

  test("every required adversarial security suite exists on disk and is collected by the API test runner", () => {
    expect(new Set(REQUIRED_SECURITY_SUITES).size).toBe(
      REQUIRED_SECURITY_SUITES.length,
    );

    const missingOnDisk = REQUIRED_SECURITY_SUITES.filter(
      (suite) => !existsSync(path.join(apiRoot, suite)),
    );
    const missingFromRunner = REQUIRED_SECURITY_SUITES.filter(
      (suite) => !discoveredSet.has(suite),
    );

    expect(missingOnDisk).toEqual([]);
    expect(missingFromRunner).toEqual([]);
  });

  test("no security suite contains skipped, todo, focused, or disabled tests", () => {
    expect(securityTestPaths.length).toBeGreaterThanOrEqual(
      REQUIRED_SECURITY_SUITES.length,
    );

    const violations: string[] = [];
    const seenPostgresGated = new Set<string>();

    for (const suite of securityTestPaths) {
      const source = readFileSync(path.join(apiRoot, suite), "utf-8");
      const inspection = inspectSecuritySuiteSource(suite, source);

      if (inspection.disabledCalls.length === 0) {
        continue;
      }

      const isAllowedPostgresGate =
        POSTGRES_GATED_SECURITY_SUITES.has(suite) &&
        inspection.referencesPostgresGateEnv &&
        inspection.disabledCalls.length === 1 &&
        inspection.disabledCalls.every(
          (finding) => finding.isSuiteLevelPostgresGateCandidate,
        );

      if (isAllowedPostgresGate) {
        seenPostgresGated.add(suite);
        continue;
      }

      violations.push(
        `${suite}: ${inspection.disabledCalls.map((finding) => finding.callee).join(", ")}`,
      );
    }

    const stalePostgresGates = [...POSTGRES_GATED_SECURITY_SUITES].filter(
      (suite) => !seenPostgresGated.has(suite),
    );

    expect(violations).toEqual([]);
    expect(stalePostgresGates).toEqual([]);
  });

  test("every security suite defines real test cases and expect() assertions", () => {
    const hollowedOut: string[] = [];

    for (const suite of securityTestPaths) {
      const source = readFileSync(path.join(apiRoot, suite), "utf-8");
      const inspection = inspectSecuritySuiteSource(suite, source);
      if (inspection.testCalls === 0 || inspection.expectCalls === 0) {
        hollowedOut.push(
          `${suite} (tests=${String(inspection.testCalls)}, expects=${String(inspection.expectCalls)})`,
        );
      }
    }

    expect(hollowedOut).toEqual([]);
  });

  test("self-test: flags skipped/todo/disabled calls and hollowed-out suites while ignoring comments", () => {
    const skipped = inspectSecuritySuiteSource(
      "synthetic-skipped.test.ts",
      `
        import { describe, expect, it, test } from "bun:test";
        describe.skip("disabled suite", () => {
          test.skip("disabled test", () => { expect(1).toBe(1); });
          it.todo("unimplemented");
          xit("legacy skip", () => { expect(1).toBe(1); });
          xdescribe("legacy describe skip", () => {});
          test.only("focused", () => { expect(1).toBe(1); });
        });
      `,
    );
    expect(skipped.disabledCalls.map((finding) => finding.callee)).toEqual([
      "describe.skip",
      "test.skip",
      "it.todo",
      "xit",
      "xdescribe",
      "test.only",
    ]);

    const hollowed = inspectSecuritySuiteSource(
      "synthetic-hollow.test.ts",
      `
        import { test } from "bun:test";
        // expect(true).toBe(true) in a comment does not count
        test("no-op", () => {
          const fake = "expect(1).toBe(1); test.skip('nope')";
          void fake;
        });
      `,
    );
    expect(hollowed.disabledCalls).toEqual([]);
    expect(hollowed.testCalls).toBe(1);
    expect(hollowed.expectCalls).toBe(0);

    const valid = inspectSecuritySuiteSource(
      "synthetic-valid.test.ts",
      `
        import { describe, expect, test } from "bun:test";
        // test.skip("commented out note")
        describe("valid", () => {
          test("enforces invariant", () => {
            expect("tenant-a").not.toBe("tenant-b");
          });
        });
      `,
    );
    expect(valid.disabledCalls).toEqual([]);
    expect(valid.testCalls).toBe(1);
    expect(valid.expectCalls).toBe(1);
  });
});
