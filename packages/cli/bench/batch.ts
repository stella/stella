// Run from packages/cli: bun run codegen:runtime && bun bench/batch.ts
// The single-command baseline excludes process startup, registry refresh and
// credential refresh; each operation still negotiates its own MCP connection.
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client";
import { panic, Result } from "better-result";
import { setTimeout as delay } from "node:timers/promises";

import { resolveEffectiveGrants } from "../src/auth/command-scopes.js";
import { runBatch } from "../src/batch/runner.js";
import { resolveBatchCommand } from "../src/commands/batch.js";
import type { Context } from "../src/context.js";
import { generatedRouteMap } from "../src/generated/route-map.js";
import { withBatchToolClient } from "../src/mcp-client.js";
import { runLeafCommand } from "../src/run-leaf-command.js";

const OPERATIONS = 1000;
const RUNS = 3;
const LATENCY_MS = 50;
const COMMAND = "contact save";
const CONCURRENCIES = [1, 6, 16];

type SampleMetrics = {
  requests: number;
  initialize: number;
  active: number;
  peak: number;
};

type Sample = {
  milliseconds: number;
  requests: number;
  initialize: number;
  peak: number;
};

const metricsByToken = new Map<string, SampleMetrics>();
const inputs = Array.from({ length: OPERATIONS }, (_, index) => ({
  type: "person",
  display_name: `Synthetic contact ${index + 1}`,
}));
const source = inputs
  .map((input, index) =>
    JSON.stringify({ command: COMMAND, input, id: `contact-${index + 1}` }),
  )
  .join("\n");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const contactSpec = () => {
  let node = generatedRouteMap;
  for (const segment of COMMAND.split(" ")) {
    if (node.kind !== "route") {
      return panic("The benchmark contact command is not a route");
    }
    const next = node.children[segment];
    if (next === undefined) {
      return panic("The baked registry has no benchmark contact command");
    }
    node = next;
  }
  if (node.kind !== "leaf" || node.spec.toolName !== "save_contact") {
    return panic("The benchmark requires the baked save_contact command");
  }
  return node.spec;
};
const spec = contactSpec();

const fixtureToken = (label: string): string => {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    sub: label,
    org_id: "benchmark-organization",
    exp: 4_102_444_800,
    scope: "stella:matters_write stella:contacts_write",
  })}.fixture`;
};

const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    if (request.method === "GET") {
      return new Response(null, { status: 405 });
    }
    const token = request.headers
      .get("authorization")
      ?.replace(/^Bearer /u, "");
    const metrics = token === undefined ? undefined : metricsByToken.get(token);
    if (metrics === undefined) {
      return new Response(null, { status: 401 });
    }
    // Read failures propagate out of the fixture instead of returning fake success.
    const body: unknown = await request.json();
    if (!isRecord(body)) {
      return new Response(null, { status: 400 });
    }
    if (body["method"] === "initialize") {
      metrics.initialize += 1;
      return Response.json({
        jsonrpc: "2.0",
        id: body["id"],
        result: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "stella-batch-latency-fixture", version: "1" },
        },
      });
    }
    if (body["method"] === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    const params = body["params"];
    if (
      body["method"] !== "tools/call" ||
      !isRecord(params) ||
      params["name"] !== "save_contact"
    ) {
      return new Response(null, { status: 400 });
    }
    metrics.requests += 1;
    metrics.active += 1;
    metrics.peak = Math.max(metrics.peak, metrics.active);
    await delay(LATENCY_MS);
    metrics.active -= 1;
    return Response.json({
      jsonrpc: "2.0",
      id: body["id"],
      result: {
        content: [{ type: "text", text: JSON.stringify({ created: true }) }],
      },
    });
  },
});

// Render into a sink while retaining the real process/stream interfaces.
const output = new Proxy(process.stdout, {
  get(target, key) {
    if (key === "write") {
      return () => true;
    }
    const value: unknown = Reflect.get(target, key);
    return value;
  },
});

const measure = async ({
  label,
  concurrency,
}: {
  label: string;
  concurrency?: number;
}): Promise<Sample> => {
  const token = fixtureToken(label);
  const metrics = { requests: 0, initialize: 0, active: 0, peak: 0 };
  metricsByToken.set(token, metrics);
  const outcome = { exitCode: 0 };
  const fixtureProcess = new Proxy(process, {
    get(target, key) {
      if (key === "stdout") {
        return output;
      }
      if (key === "exitCode") {
        return outcome.exitCode;
      }
      const value: unknown = Reflect.get(target, key);
      return value;
    },
    set(target, key, value) {
      if (key === "exitCode") {
        outcome.exitCode = value === undefined ? 0 : Number(value);
        return true;
      }
      return Reflect.set(target, key, value);
    },
  });
  const context: Context = {
    process: fixtureProcess,
    configDir: "",
    serverUrl: server.url.origin,
    token,
    effectiveGrants: resolveEffectiveGrants({ token }),
  };
  const started = performance.now();
  if (concurrency === undefined) {
    for (const input of inputs) {
      await runLeafCommand({
        context,
        spec,
        flags: { input: JSON.stringify(input), output: "json", yes: true },
      });
      if (outcome.exitCode !== 0) {
        return panic("A single-command benchmark operation failed");
      }
    }
  } else {
    const session = await withBatchToolClient({
      serverUrl: server.url.origin,
      token,
      operation: async (call) =>
        await runBatch({
          source,
          concurrency,
          resolve: (command) =>
            resolveBatchCommand({
              tree: generatedRouteMap,
              command,
              call,
              authorization: {
                token,
                effectiveGrants: context.effectiveGrants,
                serverUrl: context.serverUrl,
              },
              yes: true,
            }),
          now: () => Date.now(),
          sleep: async (milliseconds) => {
            await delay(milliseconds);
          },
        }),
    });
    if (Result.isError(session) || Result.isError(session.value)) {
      return panic("A batch benchmark session failed");
    }
    if (
      session.value.value.length !== OPERATIONS ||
      session.value.value.some((item) => item.status !== "ok")
    ) {
      return panic("A batch benchmark operation failed");
    }
  }
  const milliseconds = performance.now() - started;
  if (metrics.requests !== OPERATIONS || metrics.peak > (concurrency ?? 1)) {
    return panic("The benchmark request count or concurrency invariant failed");
  }
  metricsByToken.delete(token);
  return {
    milliseconds,
    requests: metrics.requests,
    initialize: metrics.initialize,
    peak: metrics.peak,
  };
};

const report = (mode: string, samples: readonly Sample[]) => {
  const sorted = samples
    .map(({ milliseconds }) => milliseconds)
    .toSorted((a, b) => a - b);
  const median = sorted.at(Math.floor(sorted.length / 2));
  if (median === undefined) {
    panic("The benchmark requires a median sample");
  }
  process.stdout.write(
    `${JSON.stringify({ mode, medianSeconds: Number((median / 1000).toFixed(3)), samples })}\n`,
  );
};

try {
  process.stdout.write(
    `${JSON.stringify({ methodology: "1000 synthetic contact creates per sample; 50ms per real HTTP tools/call response; baked command registry and fixture JWT; production single-command executor with a fresh MCP connection per item versus production batch resolver/runner with one shared MCP connection; process startup, registry fetch and token refresh excluded; three independent samples run concurrently within each mode, modes run sequentially", operations: OPERATIONS, latencyMs: LATENCY_MS, runs: RUNS })}\n`,
  );
  report(
    "single-command executor (sequential)",
    await Promise.all(
      Array.from(
        { length: RUNS },
        async (_, run) => await measure({ label: `single-${run}` }),
      ),
    ),
  );
  for (const concurrency of CONCURRENCIES) {
    report(
      `stella batch --concurrency ${concurrency}`,
      await Promise.all(
        Array.from(
          { length: RUNS },
          async (_, run) =>
            await measure({
              label: `batch-${concurrency}-${run}`,
              concurrency,
            }),
        ),
      ),
    );
  }
} finally {
  await server.stop(true);
}
