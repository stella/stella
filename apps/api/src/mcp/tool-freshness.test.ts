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

const register = (
  registry: McpToolFreshnessRegistry,
  session: Partial<Parameters<McpToolFreshnessRegistry["register"]>[0]> & {
    id: string;
  },
) =>
  registry.register({
    close: () => undefined,
    generation: registry.generation,
    notifyToolsChanged: () => undefined,
    organizationId: "org",
    projectTools: async () => [tool()],
    tools: [tool()],
    userId: "user",
    ...session,
  });

const expanded = [tool(), { ...tool(), name: "search_legislation" }];

describe("MCP tool freshness", () => {
  test("does not notify when nothing visible to a session changed", async () => {
    const { registry } = createRegistry();
    const notifications: string[] = [];
    register(registry, {
      id: "unchanged",
      notifyToolsChanged: () => {
        notifications.push("unchanged");
      },
    });
    await registry.publish({ organizationId: "org" });
    expect(notifications).toEqual([]);
  });

  test("notifies only the session whose admission changed its visible tools", async () => {
    const { registry } = createRegistry();
    const notifications: string[] = [];
    register(registry, {
      id: "newly-admitted",
      notifyToolsChanged: () => {
        notifications.push("newly-admitted");
      },
      projectTools: async () => expanded,
    });
    register(registry, {
      id: "already-admitted",
      notifyToolsChanged: () => {
        notifications.push("already-admitted");
      },
      projectTools: async () => expanded,
      tools: expanded,
    });
    await registry.publish({ organizationId: "org" });
    expect(notifications).toEqual(["newly-admitted"]);
  });

  test("a failing session is reported and never rejects the publication or stops its peers", async () => {
    const { registry, reported } = createRegistry();
    const notifications: string[] = [];
    const closedStream = new Error("closed stream");
    const projectionFailure = new Error("projection failed");
    register(registry, {
      id: "broken-notification",
      notifyToolsChanged: async () => await Promise.reject(closedStream),
      projectTools: async () => [tool("Expanded admission")],
    });
    register(registry, {
      id: "broken-projection",
      projectTools: async () => await Promise.reject(projectionFailure),
    });
    register(registry, {
      id: "healthy",
      notifyToolsChanged: () => {
        notifications.push("healthy");
      },
      projectTools: async () => expanded,
    });
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
    for (const id of ["oldest", "newest"]) {
      register(registry, {
        close: () => {
          closed.push(id);
        },
        id,
        notifyToolsChanged: () => {
          notifications.push(id);
        },
        projectTools: async () => expanded,
      });
    }
    expect(closed).toEqual(["oldest"]);
    expect(registry.size).toBe(1);
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

  test("a publish that ran while a session projected its tools reaches it once registered", async () => {
    const { registry } = createRegistry();
    const notified = Promise.withResolvers<string>();
    const generation = registry.generation;
    // The change lands after this session listed its tools but before it
    // registered, so the publish could not see it.
    await registry.publish({ organizationId: "org" });
    register(registry, {
      generation,
      id: "registering",
      notifyToolsChanged: () => {
        notified.resolve("registering");
      },
      projectTools: async () => expanded,
    });
    expect(await notified.promise).toBe("registering");
  });

  test("registering with no publish since its projection does not project again", async () => {
    const { registry } = createRegistry();
    let projections = 0;
    register(registry, {
      id: "current",
      projectTools: async () => {
        projections += 1;
        return [tool()];
      },
    });
    // A reprojection queued by `register` would start before this publish's
    // own, so once the publish settles only its projection may have run.
    await registry.publish({ organizationId: "org" });
    expect(projections).toBe(1);
  });

  test("a session that misses its reprojection deadline does not hold back later sessions", async () => {
    jest.useFakeTimers();
    try {
      const { registry, reported } = createRegistry({
        notificationFanOut: 1,
        reprojectionDeadlineMs: 1000,
      });
      const stuckProjection = Promise.withResolvers<readonly Tool[]>();
      const stuckNotified = Promise.withResolvers<undefined>();
      const notifications: string[] = [];
      register(registry, {
        id: "stuck",
        notifyToolsChanged: () => {
          notifications.push("stuck");
          stuckNotified.resolve(undefined);
        },
        projectTools: async () => await stuckProjection.promise,
      });
      register(registry, {
        id: "later",
        notifyToolsChanged: () => {
          notifications.push("later");
        },
        projectTools: async () => expanded,
      });
      const published = registry.publish({ organizationId: "org" });
      jest.advanceTimersByTime(1000);
      await published;
      expect(notifications).toEqual(["later"]);
      expect(reported).toHaveLength(1);
      expect(reported[0]?.operation).toBe("reproject_session");
      expect(reported[0]?.error).toBeInstanceOf(TimeoutError);
      // A late projection that is still the newest is applied when it lands.
      stuckProjection.resolve(expanded);
      await stuckNotified.promise;
      expect(notifications).toEqual(["later", "stuck"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("an overlapping publish never applies an older projection after a newer one", async () => {
    const { registry } = createRegistry();
    const projection = () => ({
      result: Promise.withResolvers<readonly Tool[]>(),
      started: Promise.withResolvers<undefined>(),
    });
    const older = projection();
    const newer = projection();
    const again = projection();
    const queued = [older, newer, again];
    const notifications: string[] = [];
    register(registry, {
      id: "racing",
      notifyToolsChanged: () => {
        notifications.push("racing");
      },
      projectTools: async () => {
        const next = queued.shift();
        if (next === undefined) {
          panic("The session projected more often than it was published to");
        }
        next.started.resolve(undefined);
        return await next.result.promise;
      },
    });
    const olderPublish = registry.publish({ organizationId: "org" });
    const newerPublish = registry.publish({ organizationId: "org" });
    await Promise.all([older.started.promise, newer.started.promise]);
    newer.result.resolve(expanded);
    await newerPublish;
    // The older projection predates the newer change and resolves last.
    older.result.resolve([tool()]);
    await olderPublish;
    expect(notifications).toEqual(["racing"]);
    // The session still holds the newer projection, so it is not a change.
    const againPublish = registry.publish({ organizationId: "org" });
    await again.started.promise;
    again.result.resolve(expanded);
    await againPublish;
    expect(notifications).toEqual(["racing"]);
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
