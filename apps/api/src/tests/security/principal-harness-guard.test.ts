/**
 * Guard ensuring security tests under `apps/api/src/tests/security/` build MCP
 * principals through the shared production-backed factory (`principal.ts`)
 * rather than hand-rolling partial contexts with `asTestRaw<AuthorizedMcpRequestContext>`
 * or pairing `createMembershipScopedDb` with manually filtered `accessibleWorkspaceIds`.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";

import { parseSource, walk } from "@stll/scripts/src/syntax-tree";

type HarnessViolation = {
  file: string;
  line: number;
  kind: "raw-mcp-context-cast" | "hand-rolled-membership-scope";
};

const FORBIDDEN_RAW_CONTEXT_TYPES = new Set([
  "AuthorizedMcpRequestContext",
  "McpRequestResources",
  "McpRequestContext",
]);

const MEMBERSHIP_DB_BUILDERS = new Set([
  "createMembershipScopedDb",
  "createMembershipSafeDb",
]);

// Suites that predate `principal.ts`. Counts only shrink as suites migrate.
const LEGACY_RAW_MCP_CONTEXT_CASTS: ReadonlyMap<string, number> = new Map([
  [
    "apps/api/src/tests/security/cross-member-time-entries.integration.test.ts",
    1,
  ],
  ["apps/api/src/tests/security/rls-agent-skill-binding.test.ts", 1],
]);

const findPrincipalHarnessViolations = (
  file: string,
  source: string,
): HarnessViolation[] => {
  const { locate, program } = parseSource(file, source);
  const violations: HarnessViolation[] = [];
  const membershipBuilderLines: number[] = [];
  const workspaceListMarkers: number[] = [];

  walk(program, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "asTestRaw" &&
      node.typeArguments?.params.some(
        (param) =>
          param.type === "TSTypeReference" &&
          param.typeName.type === "Identifier" &&
          FORBIDDEN_RAW_CONTEXT_TYPES.has(param.typeName.name),
      )
    ) {
      violations.push({
        file,
        line: locate(node.start).line,
        kind: "raw-mcp-context-cast",
      });
    }

    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      MEMBERSHIP_DB_BUILDERS.has(node.callee.name)
    ) {
      membershipBuilderLines.push(locate(node.start).line);
    }

    if (
      node.type === "Property" &&
      !node.computed &&
      node.key.type === "Identifier" &&
      node.key.name === "accessibleWorkspaceIds"
    ) {
      workspaceListMarkers.push(locate(node.start).line);
    }

    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "filterUsableMcpWorkspaces"
    ) {
      workspaceListMarkers.push(locate(node.start).line);
    }
  });

  if (workspaceListMarkers.length > 0) {
    for (const line of membershipBuilderLines) {
      violations.push({
        file,
        line,
        kind: "hand-rolled-membership-scope",
      });
    }
  }

  return violations;
};

describe("security test principal harness guard", () => {
  test("no new security tests bypass principal.ts with raw MCP context casts or hand-rolled membership scopes", async () => {
    const securityDir = import.meta.dir;
    const files = await Array.fromAsync(
      new Bun.Glob("**/*.test.ts").scan({
        cwd: securityDir,
        onlyFiles: true,
      }),
    );

    const rawCastCounts = new Map<string, number>();
    const handRolledScopes: HarnessViolation[] = [];

    for (const relativeFile of files) {
      if (relativeFile === "principal-harness-guard.test.ts") {
        continue;
      }
      const file = `apps/api/src/tests/security/${relativeFile}`;
      const source = await Bun.file(
        path.join(securityDir, relativeFile),
      ).text();
      for (const violation of findPrincipalHarnessViolations(file, source)) {
        if (violation.kind === "raw-mcp-context-cast") {
          rawCastCounts.set(file, (rawCastCounts.get(file) ?? 0) + 1);
        } else {
          handRolledScopes.push(violation);
        }
      }
    }

    expect(handRolledScopes).toEqual([]);

    const unexpectedRawCasts: string[] = [];
    for (const [file, count] of rawCastCounts) {
      const allowed = LEGACY_RAW_MCP_CONTEXT_CASTS.get(file) ?? 0;
      if (count > allowed) {
        unexpectedRawCasts.push(`${file} (${count} > allowed ${allowed})`);
      }
    }
    expect(unexpectedRawCasts).toEqual([]);

    const staleAllowlistEntries: string[] = [];
    for (const [file, allowed] of LEGACY_RAW_MCP_CONTEXT_CASTS) {
      const actual = rawCastCounts.get(file) ?? 0;
      if (actual < allowed) {
        staleAllowlistEntries.push(
          `${file} (actual ${actual} < allowed ${allowed})`,
        );
      }
    }
    expect(staleAllowlistEntries).toEqual([]);
  });

  test("self-test flags raw MCP context casts and hand-rolled membership-scoped contexts", () => {
    const rawCastSnippet = `
      const ctx = asTestRaw<AuthorizedMcpRequestContext>({
        organizationId,
        userId,
      });
    `;
    expect(
      findPrincipalHarnessViolations("synthetic-raw.test.ts", rawCastSnippet),
    ).toEqual([
      {
        file: "synthetic-raw.test.ts",
        line: 2,
        kind: "raw-mcp-context-cast",
      },
    ]);

    const handRolledScopeSnippet = `
      const scopedDb = createMembershipScopedDb(testDb, identity);
      const usable = filterUsableMcpWorkspaces({ accessibleWorkspaces, tokenWorkspaceIds });
      const ctx = { accessibleWorkspaceIds: usable.map((w) => w.id), scopedDb };
    `;
    expect(
      findPrincipalHarnessViolations(
        "synthetic-scope.test.ts",
        handRolledScopeSnippet,
      ),
    ).toEqual([
      {
        file: "synthetic-scope.test.ts",
        line: 2,
        kind: "hand-rolled-membership-scope",
      },
    ]);

    const cleanSnippet = `
      const ctx = await buildMcpSecurityPrincipal({
        db: testDb,
        organizationId,
        userId,
        tokenWorkspaceIds: [matterId],
      });
    `;
    expect(
      findPrincipalHarnessViolations("synthetic-clean.test.ts", cleanSnippet),
    ).toEqual([]);
  });
});
