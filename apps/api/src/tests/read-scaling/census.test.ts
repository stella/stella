import { describe, expect, test } from "bun:test";
import path from "node:path";

import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import api from "@/api/server";

import { runLedgerMembershipGuard } from "../../../../../scripts/ledger-membership";
import apiLedger from "./api-scaling-ledger.json";
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
const measuredApiReads = api.routes
  .filter(
    ({ method, handler }) =>
      method === "GET" &&
      readScalingScenarios.some((scenario) => scenario.handler === handler),
  )
  .map(({ method, path: routePath }) => `${method} ${routePath}`);

test("every scaling scenario exercises a mounted API handler", () => {
  for (const scenario of readScalingScenarios) {
    expect(api.routes.some(({ handler }) => handler === scenario.handler)).toBe(
      true,
    );
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
          measured,
          exemptions: ledger.unmeasuredReads,
        }),
      ).toEqual([]);
    });

    test("pending write harness ledger equals the current mutating surface", () => {
      expect(surface.writes.length).toBeGreaterThan(0);
      expect(
        scalingCoverageViolations({
          surface: surface.writes,
          measured: [],
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
          args: ["--base", "origin/main"],
        }),
      ).toBe(0);
    });
  });
}
