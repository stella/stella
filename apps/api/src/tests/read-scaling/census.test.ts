import { describe, expect, test } from "bun:test";
import path from "node:path";

import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import api from "@/api/server";

import {
  ledgerMergeBase,
  runLedgerMembershipGuard,
} from "../../../../../scripts/ledger-membership.ts";
import apiLedger from "./api-scaling-ledger.json";
import { clientInvoicePrefillScalingScenario } from "./client-invoice-prefill";
import { decisionSummaryScalingScenario } from "./decision-summary";
import { exactIconScalingScenario } from "./link-icons";
import mcpLedger from "./mcp-scaling-ledger.json";
import { mcpScalingScenarios } from "./mcp-scenarios";
import { readScalingScenarios } from "./scenarios";
import {
  apiScalingSurface,
  mcpScalingSurface,
  parseScalingLedger,
  scalingCoverageViolations,
} from "./surface";

const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const measuredApiScenarios = [
  ...readScalingScenarios,
  exactIconScalingScenario,
  decisionSummaryScalingScenario,
  clientInvoicePrefillScalingScenario,
];
const measuredApiReads = api.routes
  .filter(({ handler }) =>
    measuredApiScenarios.some((scenario) => scenario.handler === handler),
  )
  .map(({ method, path: routePath }) => `${method} ${routePath}`);

test("every scaling scenario exercises a mounted API handler", () => {
  for (const scenario of measuredApiScenarios) {
    expect(api.routes.some(({ handler }) => handler === scenario.handler)).toBe(
      true,
    );
  }
});

test("removing any mounted read scenario makes its coverage fail", () => {
  const surface = apiScalingSurface(api.routes);
  for (const scenario of measuredApiScenarios) {
    const mounted = api.routes.filter(
      ({ handler }) => handler === scenario.handler,
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

for (const { kind, surface, ledger, measured } of [
  {
    kind: "api",
    surface: apiScalingSurface(api.routes),
    ledger: apiLedger,
    measured: measuredApiReads,
  },
  {
    kind: "mcp",
    surface: mcpScalingSurface(DEFAULT_MCP_TOOL_DEFINITIONS),
    ledger: mcpLedger,
    measured: mcpScalingScenarios.map(({ name }) => name),
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
