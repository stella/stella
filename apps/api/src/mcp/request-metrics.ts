import { panic } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import { currentQueryCount } from "@/api/lib/db-query-counter";
import { emitMcpRequestMetric } from "@/api/lib/observability/request-metrics";
import type { McpMode } from "@/api/mcp/constants";

const MCP_METHODS = [
  "initialize",
  "notifications/initialized",
  "ping",
  "prompts/get",
  "prompts/list",
  "resources/list",
  "resources/read",
  "tools/call",
  "tools/list",
] as const;

export type McpMetricMethod = (typeof MCP_METHODS)[number] | "unknown";
export type McpMetricPhase =
  | "auth"
  | "context"
  | "server_build"
  | "tool_projection"
  | "dispatch"
  | "serialize";

const isMcpMetricMethod = (value: string): value is McpMetricMethod =>
  MCP_METHODS.some((method) => method === value);

export const normalizeMcpMetricMethod = (
  value: string | null,
): McpMetricMethod =>
  value !== null && isMcpMetricMethod(value) ? value : "unknown";

export const allowlistedMcpMetricToolName = (
  candidate: string,
  registeredNames: readonly string[],
): string | undefined =>
  registeredNames.some((registered) => registered === candidate)
    ? candidate
    : undefined;

type McpRequestMetricState = {
  startedAt: number;
  startedQueries: number;
  method: McpMetricMethod;
  mode: McpMode;
  path: "legacy" | "modern" | "unknown";
  toolName?: string;
  phases: Record<McpMetricPhase, number>;
  activePhase: McpMetricPhase | undefined;
};

const phaseStore = new AsyncLocalStorage<McpRequestMetricState>();

const emptyPhases = (): Record<McpMetricPhase, number> => ({
  auth: 0,
  context: 0,
  server_build: 0,
  tool_projection: 0,
  dispatch: 0,
  serialize: 0,
});

export const measureMcpPhase = async <T>(
  phase: McpMetricPhase,
  run: () => T | Promise<T>,
): Promise<T> => {
  const state = phaseStore.getStore();
  if (state === undefined) {
    return await run();
  }
  if (state.activePhase !== undefined) {
    panic(`MCP metric phases overlap: ${state.activePhase} and ${phase}`);
  }
  state.activePhase = phase;
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    state.phases[phase] += performance.now() - startedAt;
    state.activePhase = undefined;
  }
};

export const addMcpPhaseDuration = (
  phase: McpMetricPhase,
  durationMs: number,
): void => {
  const state = phaseStore.getStore();
  if (state !== undefined) {
    state.phases[phase] += durationMs;
  }
};

export const setMcpMetricProtocolPath = (path: "legacy" | "modern"): void => {
  const state = phaseStore.getStore();
  if (state !== undefined) {
    state.path = path;
  }
};

export const setMcpMetricMethodFromRequest = async (
  request: Request,
): Promise<void> => {
  const state = phaseStore.getStore();
  if (state === undefined || state.method !== "unknown") {
    return;
  }
  try {
    const body: unknown = await request.clone().json();
    if (typeof body !== "object" || body === null || !("method" in body)) {
      return;
    }
    const method = body.method;
    state.method = normalizeMcpMetricMethod(
      typeof method === "string" ? method : null,
    );
  } catch {
    // The transport owns malformed-body errors; metrics retain "unknown".
  }
};

/** Records only a name already resolved through the registered tool catalog. */
export const setMcpMetricRegisteredToolName = (toolName: string): void => {
  const state = phaseStore.getStore();
  if (state !== undefined) {
    state.toolName = toolName;
  }
};

export const observeMcpRequest = async <T>({
  method,
  mode,
  run,
}: {
  method: string | null;
  mode: McpMode;
  run: () => Promise<T>;
}): Promise<T> => {
  const state: McpRequestMetricState = {
    startedAt: performance.now(),
    startedQueries: currentQueryCount() ?? 0,
    method: normalizeMcpMetricMethod(method),
    mode,
    path: "unknown",
    phases: emptyPhases(),
    activePhase: undefined,
  };
  return await phaseStore.run(state, async () => {
    try {
      return await run();
    } finally {
      emitMcpRequestMetric({
        method: state.method,
        mode: state.mode,
        path: state.path,
        ...(state.toolName === undefined ? {} : { toolName: state.toolName }),
        phases: state.phases,
        queryCount: Math.max(
          0,
          (currentQueryCount() ?? state.startedQueries) - state.startedQueries,
        ),
        totalMs: performance.now() - state.startedAt,
      });
    }
  });
};
