import { panic } from "better-result";
import { expect, test } from "bun:test";
import * as v from "valibot";

import { env } from "@/api/env";
import { projectUsagePlan } from "@/api/handlers/usage/entitlement/usage-plan";
import { getUsageOutputContract } from "@/api/mcp/billing-tools";
import { serializeToolResult, toolDataResult } from "@/api/mcp/tool-utils";

import { callTool } from "../../../../packages/cli/src/mcp-client";
import { respondToMcpLifecycle } from "../../../../packages/cli/tests/mcp-test-lifecycle";

// The deployment flag is restored at the test boundary, as in the surface-gating tests.
test("usage advertises the plan only when the deployment enables it", () => {
  const previous = env.FEATURE_FREE_TIER;
  try {
    env.FEATURE_FREE_TIER = false;
    const legacy = getUsageOutputContract();
    expect(
      v.safeParse(legacy.outputSchemaSource, { entitlement: null }).success,
    ).toBe(true);
    expect(
      v.safeParse(legacy.outputSchemaSource, { plan: { type: "free" } })
        .success,
    ).toBe(false);
    expect(JSON.stringify(legacy.outputSchema)).not.toContain('"free"');
    env.FEATURE_FREE_TIER = true;
    const plan = getUsageOutputContract();
    expect(
      v.safeParse(plan.outputSchemaSource, { plan: { type: "free" } }).success,
    ).toBe(true);
    expect(
      v.safeParse(plan.outputSchemaSource, { entitlement: null }).success,
    ).toBe(false);
    expect(JSON.stringify(plan.outputSchema)).not.toContain(
      "serviceActionsPerPeriod",
    );
  } finally {
    env.FEATURE_FREE_TIER = previous;
  }
});

test("the current CLI receives the API usage contract under either deployment mode", async () => {
  const previous = env.FEATURE_FREE_TIER;
  const accessCases = [
    { type: "paid", deadline: new Date(), serviceActionsPerPeriod: 3 },
    { type: "evaluation", endsAt: new Date() },
    { type: "free", serviceActionsPerPeriod: 3 },
    { type: "self_managed_keys" },
  ] as const;
  try {
    for (const enabled of [false, true]) {
      env.FEATURE_FREE_TIER = enabled;
      for (const access of accessCases) {
        const response = enabled
          ? projectUsagePlan(access).unwrap()
          : { entitlement: null };
        const wire = serializeToolResult(
          toolDataResult(response),
          getUsageOutputContract(),
        );
        const server = Bun.serve({
          port: 0,
          async fetch(request) {
            const body = v.parse(
              v.object({
                id: v.exactOptional(v.union([v.string(), v.number()])),
                method: v.string(),
              }),
              await request.json(),
            );
            const lifecycle = respondToMcpLifecycle(body);
            if (lifecycle !== null) {
              return lifecycle;
            }
            return Response.json({ jsonrpc: "2.0", id: body.id, result: wire });
          },
        });
        try {
          const received = await callTool({
            serverUrl: server.url.origin,
            token: "fixture-token",
            name: "get_usage",
            args: {},
          });
          expect(received.isOk()).toBe(true);
          if (received.isErr()) {
            throw received.error;
          }
          const text = received.value.content.at(0);
          expect(text?.type).toBe("text");
          if (text === undefined) {
            panic("Missing usage response");
          }
          expect(JSON.parse(text.text)).toEqual(response);
        } finally {
          await server.stop(true);
        }
      }
    }
  } finally {
    env.FEATURE_FREE_TIER = previous;
  }
});
