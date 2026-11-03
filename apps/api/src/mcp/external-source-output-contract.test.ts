import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { buildSearchQuery, searchConsolidatedLegislation } from "@stll/boe";
import { sha256Hex } from "@stll/sha256/node";

import type { ThirdPartyOutboundReadToolName } from "@/api/handlers/chat/tools/registry-adapter/run-registry-tool";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
import { parseStrippingUndeclaredKeys } from "@/api/lib/chat/tool-output-degrade";
import {
  replay,
  replayCounterpartyCheck,
  replayRegistryLookup,
} from "@/api/mcp/__fixtures__/external-source/replay";
import { RESEARCH_ADMIN_TOOL_HANDLERS } from "@/api/mcp/research-admin-tools";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolHandler,
  getStaticMcpToolOutputContract,
  LAW_MCP_TOOL_DISPOSITION,
} from "@/api/mcp/static-tool-definitions";
import { requiresThirdPartyOutbound } from "@/api/mcp/third-party-outbound";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import { parseProvenance } from "@/api/tests/fixture-provenance";
import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const fixtureRoot = `${import.meta.dir}/__fixtures__/external-source/`;

const replayBoeSearch = async (body: string) => {
  const response = await replay({
    body,
    sourceUrl: `https://www.boe.es/datosabiertos/api/legislacion-consolidada?${new URLSearchParams(
      {
        offset: "0",
        limit: "5",
        query: buildSearchQuery({}),
      },
    ).toString()}`,
    contentType: "application/json",
    operation: async () => await searchConsolidatedLegislation({ limit: 5 }),
  });
  const scopedDb = asTestRaw<Parameters<typeof toSafeDbMock>[0]>(() =>
    panic("BOE search must not reach the database"),
  );
  const context = authorizedMcpContextForTest({
    accessibleWorkspaceIds: [],
    accessibleWorkspaceIdSet: new Set(),
    accessibleWorkspaceStatusById: new Map(),
    accessibleWorkspaces: [],
    grantedScopes: [],
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_fixture"),
    userId: toSafeId<"user">("user_fixture"),
    userEmail: "fixture@example.test",
    recordAuditEvent: async () => {},
    safeDb: toSafeDbMock(scopedDb),
    scopedDb,
    thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
    testDependencies: { searchConsolidatedLegislation: async () => response },
  });
  const result = await RESEARCH_ADMIN_TOOL_HANDLERS.search_boe_legislation({
    args: { query: "ley", limit: 5 },
    context,
  });
  if (isMcpEgressPlan(result) || result.status !== "success") {
    return panic("BOE fixture replay must return a successful search");
  }
  return result.data;
};

type SourceFixture = {
  file: string;
  capture: "recorded" | "synthetic";
  replay: (body: string) => Promise<unknown>;
};

// The handler marker derives this union: a new external read cannot omit fixtures.
// Registry captures use synthetic identities while retaining provider shapes.
const fixtures = {
  search_boe_legislation: [
    { file: "boe-search.json", capture: "recorded", replay: replayBoeSearch },
  ],
  lookup_business_registry: [
    {
      file: "brreg-agency.json",
      capture: "synthetic",
      replay: async (body) =>
        await replayRegistryLookup(body, grantThirdPartyOutboundPermit()),
    },
  ],
  check_counterparty: [
    {
      file: "adis-company.xml",
      capture: "synthetic",
      replay: replayCounterpartyCheck,
    },
  ],
} as const satisfies Record<
  ThirdPartyOutboundReadToolName,
  readonly [SourceFixture, ...SourceFixture[]]
>;

const externalReads = DEFAULT_MCP_TOOL_DEFINITIONS.filter((definition) => {
  const handler = getStaticMcpToolHandler(definition.name);
  if (handler === undefined) {
    return panic(`Missing MCP handler for ${definition.name}`);
  }
  return definition.access === "read" && requiresThirdPartyOutbound(handler);
}).map(({ name }) => name);

describe("external-source output contracts", () => {
  test("every external read registers a response fixture", () => {
    expect(
      Object.keys(fixtures).toSorted(),
      `Register a provider response fixture for every external read: ${externalReads.join(", ")}`,
    ).toEqual(externalReads.toSorted());
    for (const [name, disposition] of Object.entries(
      LAW_MCP_TOOL_DISPOSITION,
    )) {
      if (disposition === "upstream_connector") {
        expect(
          externalReads.some((read) => read === name),
          `Declare ${name} with withThirdPartyOutbound`,
        ).toBe(true);
      }
    }
  });

  for (const [toolName, recordings] of Object.entries(fixtures)) {
    test(`${toolName} preserves every provider-response field`, async () => {
      expect(
        recordings.length,
        `Register a response fixture for ${toolName}`,
      ).toBeGreaterThan(0);
      const contract =
        getStaticMcpToolOutputContract(toolName) ??
        panic(`Missing output contract for ${toolName}`);
      for (const fixture of recordings) {
        const path = `${fixtureRoot}${fixture.file}`;
        const bytes = await Bun.file(path).bytes();
        const sidecar = await Bun.file(`${path}.provenance.json`).text();
        const provenance: unknown = JSON.parse(sidecar);
        expect(provenance).toMatchObject({
          capture: fixture.capture,
          sha256: sha256Hex(bytes),
        });
        if (fixture.capture === "recorded") {
          expect(parseProvenance(sidecar)?.capture).toBe("recorded");
        } else {
          expect(provenance).toMatchObject({ note: expect.any(String) });
        }
        const data = await fixture.replay(new TextDecoder().decode(bytes));
        const parsed = parseStrippingUndeclaredKeys(
          contract.outputSchemaSource,
          contract.project(data),
        );
        if (Result.isError(parsed)) {
          expect(
            parsed.error,
            `${toolName}: ${fixture.file} violates its output contract`,
          ).toBeUndefined();
          expect.unreachable();
        }
        expect(
          parsed.value.undeclaredPaths,
          `${toolName}: ${fixture.file}`,
        ).toEqual([]);
      }
    });
  }
});
