import { describe, expect, test } from "bun:test";

import { checkDocumentationSourcePolicy } from "../.oxlint-plugins/docs-source-policy";
import { lapsedAcceptances } from "./dependency-audit-acceptance";
import { inspectLedger, parseLedger } from "./suppression-waivers";

const acceptance = {
  id: "GHSA-example",
  package: "example",
  expiresOn: "2026-08-01",
};
const current = [{ id: acceptance.id, vulnerableVersions: "<2.0.0" }];
const unrelated = {
  type: "changes",
  changedFiles: new Set(["README.md"]),
} as const;

describe("dated exception owner guards", () => {
  test("scopes documentation expiry while retaining malformed and missing coverage failures", () => {
    const warnings: string[] = [];
    const exclusion = {
      dependency: "example",
      reason: "no-llms-txt",
      explanation: "No published documentation index",
      checkedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-02T00:00:00.000Z",
    } as const;
    const options = {
      dependencies: new Set(["example"]),
      exclusions: [exclusion],
      sources: {},
      now: new Date("2026-08-03T00:00:00.000Z"),
      expiryScope: unrelated,
      onExpiryWarning: (message: string) => warnings.push(message),
    };
    expect(checkDocumentationSourcePolicy(options)).toEqual([]);
    expect(warnings.join(" ")).toContain(
      "example has an expired no-llms-txt quarantine",
    );
    expect(
      checkDocumentationSourcePolicy({
        ...options,
        exclusions: [{ ...exclusion, checkedAt: "invalid" }],
      }).join(" "),
    ).toContain("invalid no-llms-txt checkedAt");
    expect(
      checkDocumentationSourcePolicy({ ...options, exclusions: [] }).join(" "),
    ).toContain("without an llms.txt source");
    expect(
      checkDocumentationSourcePolicy({
        ...options,
        expiryScope: {
          type: "changes",
          changedFiles: new Set([".claude/mcp/doc-sources.ts"]),
        },
      }).join(" "),
    ).toContain("expired no-llms-txt");
    expect(
      checkDocumentationSourcePolicy({
        ...options,
        expiryScope: { type: "all" },
      }).join(" "),
    ).toContain("expired no-llms-txt");
  });
  test("warns unrelated advisory expiry while retaining non-clock failures", () => {
    const warnings: string[] = [];
    const options = {
      current,
      today: "2026-08-02",
      latestVersion: () => "2.0.0",
      expiryScope: unrelated,
      onExpiryWarning: (message: string) => warnings.push(message),
    };
    expect(lapsedAcceptances({ ...options, accepted: [acceptance] })).toEqual(
      [],
    );
    expect(warnings.join(" ")).toContain("GHSA-example");
    expect(warnings.join(" ")).toContain(
      "re-review scripts/dependency-audit-baseline.json",
    );
    expect(
      lapsedAcceptances({
        ...options,
        accepted: [{ ...acceptance, untilPatched: true }],
      }).at(0)?.reason,
    ).toContain("a patched release exists");
    expect(
      lapsedAcceptances({
        ...options,
        accepted: [{ ...acceptance, expiresOn: "2026-13-01" }],
      }).at(0)?.reason,
    ).toContain("not a YYYY-MM-DD calendar date");
    expect(
      lapsedAcceptances({ ...options, accepted: [acceptance], current: [] }).at(
        0,
      )?.reason,
    ).toContain("no longer reported");
  });

  test.each(["all", "changes"])(
    "blocks advisory expiry in its owning scope: %s",
    (scopeType) => {
      const expiryScope =
        scopeType === "all"
          ? ({ type: "all" } as const)
          : ({
              type: "changes",
              changedFiles: new Set(["scripts/dependency-audit-baseline.json"]),
            } as const);
      expect(
        lapsedAcceptances({
          accepted: [acceptance],
          current,
          today: "2026-08-02",
          latestVersion: () => "1.0.0",
          expiryScope,
        }).at(0)?.reason,
      ).toContain("expired on");
    },
  );

  test("scopes suppression expiry while preserving observation and evidence checks", () => {
    const waiver = {
      id: "SW-0001",
      rule: "security-guards/no-unscoped-user-query",
      file: "apps/api/src/example.ts",
      symbol: "listExample",
      count: 1,
      reason: "Reviewed exception",
      evidence: "apps/api/src/example.test.ts",
      kind: "temporary",
      expires: "2026-08-01",
    };
    const parsed = parseLedger({ waivers: [waiver] });
    expect(parsed.status).toBe("valid");
    if (parsed.status !== "valid") {
      return;
    }
    const warnings: string[] = [];
    const input = {
      ledger: parsed.ledger,
      observation: { observed: [waiver], bare: [] },
      evidenceExists: () => true,
      evidenceContains: () => true,
      today: "2026-08-02",
      expiryScope: unrelated,
      onExpiryWarning: (message: string) => warnings.push(message),
    };
    expect(inspectLedger(input)).toEqual([]);
    expect(warnings.join(" ")).toContain("SW-0001: temporary waiver expired");
    expect(
      inspectLedger({ ...input, evidenceExists: () => false }).join(" "),
    ).toContain("does not exist");
    expect(
      inspectLedger({ ...input, observation: { observed: [], bare: [] } })
        .length,
    ).toBeGreaterThan(0);
    for (const file of ["scripts/suppression-waivers.json", waiver.file]) {
      expect(
        inspectLedger({
          ...input,
          expiryScope: { type: "changes", changedFiles: new Set([file]) },
        }).join(" "),
      ).toContain("expired on");
    }
    expect(
      inspectLedger({ ...input, expiryScope: { type: "all" } }).join(" "),
    ).toContain("expired on");
  });
});
