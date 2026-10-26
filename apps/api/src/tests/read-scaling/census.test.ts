import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isRecord } from "@/api/lib/type-guards";
import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import { apiApp } from "@/api/server";

import {
  ledgerGitEnv,
  ledgerMergeBase,
  runLedgerMembershipGuard,
} from "../../../../../scripts/ledger-membership.ts";
import apiLedger from "./api-scaling-ledger.json";
import { claimCommentScalingScenarios } from "./claim-comments";
import { decisionSummaryScalingScenario } from "./decision-summary";
import { exactIconScalingScenario } from "./link-icons";
import mcpLedger from "./mcp-scaling-ledger.json";
import { mcpScalingScenarios } from "./mcp-scenarios";
import {
  readScenarioRegistry,
  scenarioMembershipViolations,
} from "./scenario-membership";
import { readScalingScenarios } from "./scenarios";
import {
  apiScalingSurface,
  mcpScalingSurface,
  parseScalingLedger,
  scalingCoverageViolations,
  withNewWriteRoutes,
} from "./surface";
import { suggestionRangeScalingScenario } from "./time-suggestion-range";
import { writeScalingScenarios } from "./write-scenarios";

const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const measuredApiScenarios = [
  ...readScalingScenarios,
  ...writeScalingScenarios,
  exactIconScalingScenario,
  decisionSummaryScalingScenario,
  ...claimCommentScalingScenarios,
  suggestionRangeScalingScenario,
];
const measuredApiReads = apiApp.routes
  .filter(({ definition }) =>
    measuredApiScenarios.some((scenario) => scenario.definition === definition),
  )
  .map(({ method, path: routePath }) => `${method} ${routePath}`);

test("previously measured scenarios retain their handler or tool identity", async () => {
  const base = ledgerMergeBase({ repoRoot, baseRef: "origin/main" });
  const readBaseSource = (file: string) => {
    const result = Bun.spawnSync(["git", "show", `${base}:${file}`], {
      cwd: repoRoot,
      env: ledgerGitEnv(),
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      return panic(
        `Cannot read base scaling registry ${file}: ${result.stderr.toString()}`,
      );
    }
    return result.stdout.toString();
  };
  for (const registry of [
    {
      kind: "api",
      file: "apps/api/src/tests/read-scaling/census.test.ts",
      symbol: "measuredApiScenarios",
      runtimeNames: measuredApiScenarios.map(({ name }) => name),
    },
    {
      kind: "mcp",
      file: "apps/api/src/tests/read-scaling/mcp-scenarios.ts",
      symbol: "mcpScalingScenarios",
      runtimeNames: mcpScalingScenarios.map(({ name }) => name),
    },
  ] as const) {
    const current = readScenarioRegistry({
      ...registry,
      readSource: (file) => readFileSync(path.join(repoRoot, file), "utf-8"),
    });
    expect(current.map(({ name }) => name)).toEqual(registry.runtimeNames);
    for (const entry of current) {
      if (entry.kind !== "api") {
        continue;
      }
      const ownerModule: unknown = await import(
        path.join(repoRoot, entry.handlerOwner.file)
      );
      if (!isRecord(ownerModule)) {
        panic(
          `Missing scaling handler export ${entry.handlerOwner.file}#${entry.handlerOwner.exportName}`,
        );
      }
      const owner = ownerModule[entry.handlerOwner.exportName];
      if (!isRecord(owner)) {
        panic(
          `Scaling owner is not an endpoint definition: ${entry.handlerOwner.file}#${entry.handlerOwner.exportName}`,
        );
      }
      const measured = measuredApiScenarios.find(
        ({ name }) => name === entry.name,
      );
      expect(measured?.definition === owner).toBe(true);
    }
    expect(
      scenarioMembershipViolations({
        base: readScenarioRegistry({ ...registry, readSource: readBaseSource }),
        current,
      }),
    ).toEqual([]);
  }
});

test("every scaling scenario exercises a mounted API handler", () => {
  for (const scenario of measuredApiScenarios) {
    expect(
      apiApp.routes.some(
        ({ definition }) => definition === scenario.definition,
      ),
    ).toBe(true);
  }
});

test("removing any mounted read scenario makes its coverage fail", () => {
  const surface = apiScalingSurface(apiApp.routes);
  for (const scenario of measuredApiScenarios) {
    const mounted = apiApp.routes.filter(
      ({ definition }) => definition === scenario.definition,
    );
    expect(mounted.length, scenario.name).toBeGreaterThan(0);
    for (const { method, path: routePath } of mounted) {
      const id = `${method} ${routePath}`;
      const reads = surface.reads.includes(id);
      const members = reads ? surface.reads : surface.writes;
      const exemptions = reads
        ? apiLedger.unmeasuredReads
        : apiLedger.pendingWriteHarness;
      expect(measuredApiReads, scenario.name).toContain(id);
      expect(
        scalingCoverageViolations({
          surface: members,
          measured: measuredApiReads.filter(
            (measured) => measured !== id && members.includes(measured),
          ),
          exemptions,
        }),
        scenario.name,
      ).toContain(`unmeasured: ${id}`);
    }
  }
});

test("every MCP scenario names a registered tool", () => {
  for (const scenario of mcpScalingScenarios) {
    expect(
      DEFAULT_MCP_TOOL_DEFINITIONS.some(({ name }) => name === scenario.name),
    ).toBe(true);
  }
});

// The HTTP core lists a route without the trailing slash Elysia gave a
// prefix's index route; a base ledger may still spell it with one.
const withoutTrailingSlash = (entries: string[]) =>
  entries.map((entry) =>
    entry.endsWith("/") && !entry.endsWith(" /") ? entry.slice(0, -1) : entry,
  );

for (const { kind, surface, ledger, measured, normalizeBaseEntries } of [
  {
    kind: "api",
    surface: apiScalingSurface(apiApp.routes),
    ledger: apiLedger,
    measured: measuredApiReads,
    normalizeBaseEntries: withoutTrailingSlash,
  },
  {
    kind: "mcp",
    surface: mcpScalingSurface(DEFAULT_MCP_TOOL_DEFINITIONS),
    ledger: mcpLedger,
    measured: mcpScalingScenarios.map(({ name }) => name),
    normalizeBaseEntries: undefined,
  },
]) {
  describe(`${kind} scaling census`, () => {
    test("every read has an exercised case or reasoned exemption", () => {
      expect(surface.reads.length).toBeGreaterThan(0);
      expect(
        scalingCoverageViolations({
          surface: surface.reads,
          measured: measured.filter((id) => surface.reads.includes(id)),
          exemptions: ledger.unmeasuredReads,
        }),
      ).toEqual([]);
    });

    test("pending write harness entries cover unmeasured non-GET routes", () => {
      expect(surface.writes.length).toBeGreaterThan(0);
      expect(
        scalingCoverageViolations({
          surface: surface.writes,
          measured: measured.filter((id) => surface.writes.includes(id)),
          exemptions: ledger.pendingWriteHarness,
        }),
      ).toEqual([]);
    });

    test("read exemptions and pending write entries can only shrink", () => {
      expect(
        runLedgerMembershipGuard({
          ledgerRel: `apps/api/src/tests/read-scaling/${kind}-scaling-ledger.json`,
          repoRoot,
          parseLedger: parseScalingLedger,
          // A write route this change mounts may enter with its reason.
          normalizeBaseEntries: (base) =>
            withNewWriteRoutes({
              base: normalizeBaseEntries?.(base) ?? base,
              current: parseScalingLedger(
                JSON.stringify(ledger),
                `${kind}-scaling`,
              ),
              writes: surface.writes,
            }),
          label: `${kind}-scaling`,
          remediation:
            "add an exercised scaling case instead of a ledger entry",
          args: [
            "--base",
            ledgerMergeBase({ repoRoot, baseRef: "origin/main" }),
          ],
        }),
      ).toBe(0);
    });
  });
}
