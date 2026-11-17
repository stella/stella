import type { Tool } from "@modelcontextprotocol/server";
import { panic } from "better-result";
import { describe, expect, jest, test } from "bun:test";

import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";
import { MCP_REGISTRY_VERSION_HEADER } from "@stll/api-contract/mcp-registry";
import { TimeoutError } from "@stll/concurrency/with-timeout";

import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import { createMcpCorsHeaders } from "@/api/mcp/metadata";
import { ALL_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import {
  type McpToolFreshnessOperation,
  McpToolFreshnessRegistry,
} from "@/api/mcp/tool-freshness";
import { withMcpRegistryVersionHeader } from "@/api/mcp/tool-freshness-response";
import {
  MCP_TOOL_SCHEMA_VERSION_META_KEY,
  mcpRegistryVersion,
  mcpToolSchemaVersion,
  withMcpToolSchemaVersion,
} from "@/api/mcp/tool-versions";

const tool = (description = "Search admitted law"): Tool => ({
  annotations: { readOnlyHint: true, title: "Search law" },
  description,
  inputSchema: { properties: { query: { type: "string" } }, type: "object" },
  name: "search_law",
  outputSchema: { properties: { result: { type: "string" } }, type: "object" },
  title: "Search law",
});

type ReportedFailure = {
  error: unknown;
  operation: McpToolFreshnessOperation;
};

const createRegistry = (
  options: {
    capacity?: number;
    notificationFanOut?: number;
    reprojectionDeadlineMs?: number;
  } = {},
) => {
  const reported: ReportedFailure[] = [];
  const firstReport = Promise.withResolvers<ReportedFailure>();
  const registry = new McpToolFreshnessRegistry({
    ...options,
    reportError: (error, operation) => {
      reported.push({ error, operation });
      firstReport.resolve({ error, operation });
    },
  });
  return { firstReport: firstReport.promise, registry, reported };
};

type SessionOptions = Partial<
  Parameters<McpToolFreshnessRegistry["register"]>[0]
> & {
  id: string;
};

const register = (
  registry: McpToolFreshnessRegistry,
  session: SessionOptions,
) =>
  registry.register({
    close: () => undefined,
    notifyToolsChanged: () => undefined,
    organizationId: "org",
    projectTools: async () => [tool()],
    userId: "user",
    ...session,
  });

/** Registers a session and waits for its opening projection to settle. */
const open = async (
  registry: McpToolFreshnessRegistry,
  session: SessionOptions,
) => {
  const registration = register(registry, session);
  await registration.opened;
  return registration;
};

const expanded = [tool(), { ...tool(), name: "search_legislation" }];

/** A projection whose result the test hands over when it chooses. */
const deferredProjection = () => ({
  result: Promise.withResolvers<readonly Tool[]>(),
  started: Promise.withResolvers<undefined>(),
});

describe("MCP tool freshness", () => {
  test("an opened stream is told once to list again, then only on a change", async () => {
    const { registry } = createRegistry();
    const notifications: string[] = [];
    await open(registry, {
      id: "opened",
      notifyToolsChanged: () => {
        notifications.push("opened");
      },
    });
    // The client may have listed before its stream opened.
    expect(notifications).toEqual(["opened"]);
    await registry.publish({ organizationId: "org" });
    expect(notifications).toEqual(["opened"]);
  });

  test("notifies only the session whose admission changed its visible tools", async () => {
    const { registry } = createRegistry();
    const notifications: string[] = [];
    let admitted = false;
    await open(registry, {
      id: "newly-admitted",
      notifyToolsChanged: () => {
        notifications.push("newly-admitted");
      },
      projectTools: async () => (admitted ? expanded : [tool()]),
    });
    await open(registry, {
      id: "already-admitted",
      notifyToolsChanged: () => {
        notifications.push("already-admitted");
      },
      projectTools: async () => expanded,
    });
    notifications.length = 0;
    admitted = true;
    await registry.publish({ organizationId: "org" });
    expect(notifications).toEqual(["newly-admitted"]);
  });

  test("a failing opening projection keeps the stream and the next change still reaches it", async () => {
    const { registry, reported } = createRegistry();
    const notifications: string[] = [];
    const backingStoreDown = new Error("tool list unavailable");
    let available = false;
    await open(registry, {
      id: "opened-during-outage",
      notifyToolsChanged: () => {
        notifications.push("opened-during-outage");
      },
      projectTools: async () =>
        available ? [tool()] : await Promise.reject(backingStoreDown),
    });
    expect(reported).toEqual([
      { error: backingStoreDown, operation: "reproject_session" },
    ]);
    expect(registry.size).toBe(1);
    expect(notifications).toEqual([]);
    available = true;
    await registry.publish({ organizationId: "org" });
    // What the client holds is unknown, so the first projection that lands
    // is a change.
    expect(notifications).toEqual(["opened-during-outage"]);
  });

  test("a failing session is reported and never rejects the publication or stops its peers", async () => {
    const { registry, reported } = createRegistry();
    const notifications: string[] = [];
    const closedStream = new Error("closed stream");
    const projectionFailure = new Error("projection failed");
    let changed = false;
    await open(registry, {
      id: "broken-notification",
      notifyToolsChanged: async () => {
        if (changed) {
          await Promise.reject(closedStream);
        }
      },
      projectTools: async () =>
        changed ? [tool("Expanded admission")] : [tool()],
    });
    await open(registry, {
      id: "broken-projection",
      projectTools: async () =>
        changed ? await Promise.reject(projectionFailure) : [tool()],
    });
    await open(registry, {
      id: "healthy",
      notifyToolsChanged: () => {
        notifications.push("healthy");
      },
      projectTools: async () => (changed ? expanded : [tool()]),
    });
    notifications.length = 0;
    changed = true;
    await registry.publish({ organizationId: "org" });
    expect(notifications).toEqual(["healthy"]);
    expect(reported).toHaveLength(2);
    expect(reported).toContainEqual({
      error: closedStream,
      operation: "reproject_session",
    });
    expect(reported).toContainEqual({
      error: projectionFailure,
      operation: "reproject_session",
    });
  });

  test("evicting the oldest session at capacity ends its stream and stops its signals", async () => {
    const { registry, reported } = createRegistry({ capacity: 1 });
    const closed: string[] = [];
    const notifications: string[] = [];
    let admitted = false;
    const session = (id: string): SessionOptions => ({
      close: () => {
        closed.push(id);
      },
      id,
      notifyToolsChanged: () => {
        notifications.push(id);
      },
      projectTools: async () => (admitted ? expanded : [tool()]),
    });
    await open(registry, session("oldest"));
    await open(registry, session("newest"));
    expect(closed).toEqual(["oldest"]);
    expect(registry.size).toBe(1);
    notifications.length = 0;
    admitted = true;
    await registry.publish({ organizationId: "org" });
    expect(notifications).toEqual(["newest"]);
    expect(reported).toEqual([]);
  });

  test("a stream that fails to end on eviction is reported", async () => {
    const { firstReport, registry } = createRegistry({ capacity: 1 });
    const closeFailure = new Error("stream already gone");
    register(registry, {
      close: async () => await Promise.reject(closeFailure),
      id: "oldest",
    });
    register(registry, { id: "newest" });
    expect(await firstReport).toEqual({
      error: closeFailure,
      operation: "close_session",
    });
  });

  test("changes published while a session projects run one more projection after it, never beside it", async () => {
    const { registry } = createRegistry();
    const running = deferredProjection();
    const rerun = deferredProjection();
    const queued = [running, rerun];
    const notifications: string[] = [];
    let inFlight = 0;
    let mostInFlight = 0;
    let projections = 0;
    await open(registry, {
      id: "racing",
      notifyToolsChanged: () => {
        notifications.push("racing");
      },
      projectTools: async () => {
        projections += 1;
        if (projections === 1) {
          return [tool()];
        }
        const next = queued.shift();
        if (next === undefined) {
          panic("The session projected more often than its changes need");
        }
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        next.started.resolve(undefined);
        const tools = await next.result.promise;
        inFlight -= 1;
        return tools;
      },
    });
    expect(notifications).toEqual(["racing"]);
    const first = registry.publish({ organizationId: "org" });
    await running.started.promise;
    // Two more changes land while the first projection runs; both are
    // covered by a single rerun that starts after it settles.
    const second = registry.publish({ organizationId: "org" });
    const third = registry.publish({ organizationId: "org" });
    expect(projections).toBe(2);
    running.result.resolve([tool()]);
    await first;
    await rerun.started.promise;
    expect(projections).toBe(3);
    rerun.result.resolve(expanded);
    await Promise.all([second, third]);
    expect(mostInFlight).toBe(1);
    expect(notifications).toEqual(["racing", "racing"]);
  });

  test("a session that misses its deadline keeps one projection running and still applies the newest change", async () => {
    jest.useFakeTimers();
    try {
      const { registry, reported } = createRegistry({
        notificationFanOut: 1,
        reprojectionDeadlineMs: 1000,
      });
      const stuck = deferredProjection();
      const afterStuck = deferredProjection();
      const queued = [stuck, afterStuck];
      const notifications: string[] = [];
      let stuckProjections = 0;
      let opened = false;
      let admitted = false;
      await open(registry, {
        id: "stuck",
        notifyToolsChanged: () => {
          notifications.push("stuck");
        },
        projectTools: async () => {
          stuckProjections += 1;
          if (!opened) {
            return [tool()];
          }
          const next = queued.shift();
          if (next === undefined) {
            panic("The session projected more often than its changes need");
          }
          next.started.resolve(undefined);
          return await next.result.promise;
        },
      });
      await open(registry, {
        id: "later",
        notifyToolsChanged: () => {
          notifications.push("later");
        },
        projectTools: async () => (admitted ? expanded : [tool()]),
      });
      opened = true;
      admitted = true;
      notifications.length = 0;
      const published = registry.publish({ organizationId: "org" });
      await stuck.started.promise;
      jest.advanceTimersByTime(1000);
      await published;
      expect(notifications).toEqual(["later"]);
      expect(reported).toHaveLength(1);
      expect(reported[0]?.operation).toBe("reproject_session");
      expect(reported[0]?.error).toBeInstanceOf(TimeoutError);
      // The deadline released the publish, not the projection: a change
      // published now waits for it instead of starting a second one.
      const republished = registry.publish({ organizationId: "org" });
      expect(stuckProjections).toBe(2);
      stuck.result.resolve([tool("Stale admission")]);
      await afterStuck.started.promise;
      expect(stuckProjections).toBe(3);
      afterStuck.result.resolve(expanded);
      await republished;
      expect(notifications).toEqual(["later", "stuck", "stuck"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a stalled session holds one slot while the rest of the publish carries on", async () => {
    jest.useFakeTimers();
    try {
      const { registry } = createRegistry({
        notificationFanOut: 2,
        reprojectionDeadlineMs: 1000,
      });
      const stalled = Promise.withResolvers<readonly Tool[]>();
      let admitted = false;
      await open(registry, {
        id: "stalled",
        projectTools: async () => (admitted ? await stalled.promise : [tool()]),
      });
      const healthy = ["first", "second", "third"];
      const reached = new Map(
        healthy.map((id) => [id, Promise.withResolvers<undefined>()]),
      );
      await Promise.all(
        healthy.map(
          async (id) =>
            await open(registry, {
              id,
              notifyToolsChanged: () => {
                if (admitted) {
                  reached.get(id)?.resolve(undefined);
                }
              },
              projectTools: async () => (admitted ? expanded : [tool()]),
            }),
        ),
      );
      admitted = true;
      const published = registry.publish({ organizationId: "org" });
      // No timer has moved, so every healthy session was notified while the
      // stalled one still held its slot.
      await Promise.all(
        [...reached.values()].map(async ({ promise }) => {
          await promise;
        }),
      );
      jest.advanceTimersByTime(1000);
      await published;
      stalled.resolve([tool()]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("browser clients may read the registry version header", () => {
    expect(
      createMcpCorsHeaders().get("Access-Control-Expose-Headers")?.split(", "),
    ).toContain(MCP_REGISTRY_VERSION_HEADER);
  });

  test("per-tool versions change for every and only advertised contract field", () => {
    const original = tool();
    const version = mcpToolSchemaVersion(original);
    const contractChanges: Tool[] = [
      { ...original, name: "search_legislation" },
      { ...original, title: "Search legislation" },
      { ...original, description: "Search admitted legislation" },
      { ...original, inputSchema: { properties: {}, type: "object" } },
      { ...original, outputSchema: { properties: {}, type: "object" } },
      { ...original, annotations: { readOnlyHint: false } },
    ];
    for (const changed of contractChanges) {
      expect(mcpToolSchemaVersion(changed)).not.toBe(version);
    }
    expect(
      mcpToolSchemaVersion({ ...original, _meta: { private: true } }),
    ).toBe(version);
    expect(version).toMatch(/^[a-f0-9]{16}$/u);
    expect(
      withMcpToolSchemaVersion(original)._meta?.[
        MCP_TOOL_SCHEMA_VERSION_META_KEY
      ],
    ).toBe(version);
  });

  test("the compact version prefix has no collisions in the registered surface", () => {
    const tools = toMcpTools(ALL_MCP_TOOL_DEFINITIONS, { mode: "advanced" });
    const versions = tools.map(mcpToolSchemaVersion);
    expect(new Set(versions).size).toBe(tools.length);
  });

  test("the response header equals the returned projection version", () => {
    const tools = [tool()];
    const projectionVersion = mcpRegistryVersion(tools);
    const response = withMcpRegistryVersionHeader(
      new Response(JSON.stringify({ tools })),
      projectionVersion,
    );
    expect(response.headers.get(MCP_REGISTRY_VERSION_HEADER)).toBe(
      projectionVersion,
    );
  });

  test("jurisdiction descriptions match the registered admissions", () => {
    const descriptions: string[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const child of value) {
          visit(child);
        }
        return;
      }
      if (typeof value !== "object" || value === null) {
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (key === "description" && typeof child === "string") {
          descriptions.push(child);
        } else {
          visit(child);
        }
      }
    };
    for (const definition of ALL_MCP_TOOL_DEFINITIONS) {
      visit(definition.inputSchema);
    }
    const advertised = descriptions
      .map((description) => /Admitted: ([A-Z, ]+)\./u.exec(description)?.[1])
      .filter((value) => value !== undefined);
    expect(advertised.length).toBeGreaterThan(0);
    expect(new Set(advertised)).toEqual(
      new Set([
        PUBLIC_CASE_LAW_COUNTRIES.join(", "),
        PUBLIC_LEGISLATION_COUNTRIES.join(", "),
      ]),
    );
  });
});
