/**
 * Measure the server-side cost of one MCP request through the production
 * transport handler: token check, server construction, the `tools/list`
 * projection (static registry, feature and scope filtering, schema scoping)
 * and response framing. Authentication and session-context resolution are
 * stubbed with a fixed principal, so the numbers isolate the per-call work the
 * process does on its own rather than database or network latency. The
 * package script preloads the API test environment, so no `.env` is needed.
 *
 * Usage:
 *   bun --filter @stll/api bench:mcp-call
 *   bun --filter @stll/api bench:mcp-call --iterations=2000
 *   bun --filter @stll/api bench:mcp-call --json
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { panic, Result } from "better-result";
import * as v from "valibot";

import { toSafeId } from "@/api/lib/branded-types";
import { createFeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import { recordMcpSessionInitialized } from "@/api/mcp/client-identity";
import { MCP_DEFAULT_RESOURCE_SCOPES } from "@/api/mcp/constants";
import type { McpRequestResources } from "@/api/mcp/context";
import { listMcpResources, readMcpResource } from "@/api/mcp/resources";
import { createMcpHttpRequestHandler } from "@/api/mcp/server-core";
import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import {
  getMcpToolDefinition,
  getMcpToolRequiredScopesHint,
  handleMcpToolCall,
  listMcpTools,
} from "@/api/mcp/tools";

const DEFAULT_ITERATIONS = 500;
const WARMUP_ITERATIONS = 50;
const PROTOCOL_VERSION = "2026-07-28";
const EXPECTED_DEFAULT_TOOL_NAME =
  DEFAULT_MCP_TOOL_DEFINITIONS.at(0)?.name ??
  panic("The default MCP surface has no tools");

const iterations = Number(
  process.argv
    .find((argument) => argument.startsWith("--iterations="))
    ?.slice("--iterations=".length) ?? DEFAULT_ITERATIONS,
);
if (!Number.isInteger(iterations) || iterations <= 0) {
  panic("--iterations must be a positive integer");
}

const organizationId = toSafeId<"organization">("org_bench");
const userId = toSafeId<"user">("user_bench");
// The default resource scopes grant neither the skill nor the connector
// family, which read the database; the static surface is what every session
// pays for.
const scopes = MCP_DEFAULT_RESOURCE_SCOPES;

const unusedDb = () => panic("The MCP benchmark context has no database");

// No feature enrolments: invitation-only features stay hidden, as they are for
// most organizations, so the descriptor-scoping path runs.
const context: McpRequestResources = {
  accessibleWorkspaceIds: [],
  accessibleWorkspaceIdSet: new Set(),
  accessibleWorkspaceStatusById: new Map(),
  accessibleWorkspaces: [],
  featureAccessSnapshot: createFeatureAccessSnapshot({
    organizationId,
    userId,
    decisions: new Map(),
  }),
  grantedScopes: scopes,
  memberRole: "owner",
  organizationId,
  recordAuditEvent: async () => await Promise.resolve(),
  safeDb: unusedDb,
  scopedDb: unusedDb,
  userEmail: "bench@example.test",
  userId,
};

const handler = createMcpHttpRequestHandler({
  authenticateMcpRequest: async () =>
    await Promise.resolve(
      Result.ok({ organizationId, scopes: [...scopes], userId }),
    ),
  captureError: (error) => {
    throw error;
  },
  getMcpToolDefinition,
  getMcpToolRequiredScopesHint,
  handleMcpToolCall,
  listMcpResources,
  listMcpTools,
  readMcpResource,
  recordMcpSessionInitialized,
  resolveMcpSessionContext: async () => await Promise.resolve(context),
});

const toolsListRequest = (id: number) =>
  new Request("http://localhost/mcp", {
    body: JSON.stringify({
      id,
      jsonrpc: "2.0",
      method: "tools/list",
      params: {
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: { name: "stella-bench", version: "1.0.0" },
          [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
        },
      },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer bench",
      "content-type": "application/json",
      "mcp-method": "tools/list",
      "mcp-protocol-version": PROTOCOL_VERSION,
    },
    method: "POST",
  });

const toolsListResponseSchema = v.object({
  result: v.object({ tools: v.array(v.object({ name: v.string() })) }),
});

const callOnce = async (id: number): Promise<number> => {
  const startedAt = Bun.nanoseconds();
  const response = await handler(toolsListRequest(id));
  const body = await response.text();
  const elapsed = Bun.nanoseconds() - startedAt;
  const parsed = v.safeParse(toolsListResponseSchema, JSON.parse(body));
  if (
    response.status !== 200 ||
    !parsed.success ||
    !parsed.output.result.tools.some(
      ({ name }) => name === EXPECTED_DEFAULT_TOOL_NAME,
    )
  ) {
    panic(`tools/list answered ${response.status}: ${body.slice(0, 200)}`);
  }
  return elapsed / 1e6;
};

const percentile = (sorted: readonly number[], fraction: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
  panic("No samples recorded");

for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
  await callOnce(index);
}

const samples: number[] = [];
for (let index = 0; index < iterations; index += 1) {
  samples.push(await callOnce(WARMUP_ITERATIONS + index));
}
const sorted = samples.toSorted((left, right) => left - right);
const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
const summary = {
  call: "tools/list (default surface)",
  iterations,
  meanMs: Number(mean.toFixed(3)),
  p50Ms: Number(percentile(sorted, 0.5).toFixed(3)),
  p95Ms: Number(percentile(sorted, 0.95).toFixed(3)),
  p99Ms: Number(percentile(sorted, 0.99).toFixed(3)),
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} else {
  process.stdout.write(
    `${summary.call}: ${summary.iterations} calls, mean ${summary.meanMs} ms, p50 ${summary.p50Ms} ms, p95 ${summary.p95Ms} ms, p99 ${summary.p99Ms} ms\n`,
  );
}
// The database pools the API graph opens at import keep the loop alive.
process.exit(0);
