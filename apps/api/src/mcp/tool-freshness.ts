import type { Tool } from "@modelcontextprotocol/server";

import { withTimeout } from "@stll/concurrency/with-timeout";

import { captureError, detached } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import {
  announceMcpToolProjectionChange,
  registerMcpToolProjectionDelivery,
} from "@/api/lib/sse";
import { mcpRegistryVersion } from "@/api/mcp/tool-versions";

const MAX_NOTIFICATION_FAN_OUT = 16;
const MAX_LIVE_TOOL_SESSIONS = 1024;
/** How long one session's reprojection and notification may hold its batch. */
const SESSION_REPROJECTION_DEADLINE_MS = 10_000;

/** Whose tool projection can have changed: a whole organisation or one member. */
export type McpToolProjectionIdentity = {
  organizationId: SafeId<"organization">;
  userId?: SafeId<"user"> | undefined;
};

export type McpToolFreshnessOperation = "close_session" | "reproject_session";

export type ReportMcpToolFreshnessError = (
  error: unknown,
  operation: McpToolFreshnessOperation,
) => void;

type LiveToolSession = {
  readonly close: () => Promise<void> | void;
  readonly notifyToolsChanged: () => Promise<void> | void;
  readonly organizationId: string;
  readonly projectTools: () => Promise<readonly Tool[]>;
  readonly userId: string;
  /** Version of the projection this client was last shown or told about. */
  projectionVersion: string;
  /** Sequence of the newest reprojection started for this session. */
  reprojection: number;
};

/**
 * Tracks the last projection shown to each live client. Writers can publish a
 * new projection after admission or feature-enrolment changes; unchanged
 * clients are skipped and notification failures are isolated from the write.
 */
export class McpToolFreshnessRegistry {
  readonly #sessions = new Map<string, LiveToolSession>();
  readonly #capacity: number;
  readonly #notificationFanOut: number;
  readonly #reprojectionDeadlineMs: number;
  readonly #reportError: ReportMcpToolFreshnessError;
  #generation = 0;

  constructor({
    capacity = MAX_LIVE_TOOL_SESSIONS,
    notificationFanOut = MAX_NOTIFICATION_FAN_OUT,
    reportError,
    reprojectionDeadlineMs = SESSION_REPROJECTION_DEADLINE_MS,
  }: {
    capacity?: number;
    notificationFanOut?: number;
    reportError: ReportMcpToolFreshnessError;
    reprojectionDeadlineMs?: number;
  }) {
    this.#capacity = capacity;
    this.#notificationFanOut = notificationFanOut;
    this.#reportError = reportError;
    this.#reprojectionDeadlineMs = reprojectionDeadlineMs;
  }

  /**
   * Advances when a publish starts. A caller reads it before projecting the
   * tools it registers with, so `register` can tell whether a publish ran
   * while that session was not yet visible to it.
   */
  get generation(): number {
    return this.#generation;
  }

  register({
    close,
    generation,
    id,
    notifyToolsChanged,
    organizationId,
    projectTools,
    tools,
    userId,
  }: {
    /** Ends the client's stream so its host reconnects and lists again. */
    close: LiveToolSession["close"];
    /** `generation` as read before `tools` were projected. */
    generation: number;
    id: string;
    notifyToolsChanged: LiveToolSession["notifyToolsChanged"];
    organizationId: string;
    projectTools: LiveToolSession["projectTools"];
    tools: readonly Tool[];
    userId: string;
  }): () => void {
    if (this.#sessions.size >= this.#capacity) {
      const oldest = this.#sessions.entries().next().value;
      if (oldest !== undefined) {
        const [oldestId, evicted] = oldest;
        this.#sessions.delete(oldestId);
        // An evicted client would stay connected without further signals.
        detached(this.#close(evicted), "mcp.tool-freshness-evict");
      }
    }
    const session: LiveToolSession = {
      close,
      notifyToolsChanged,
      organizationId,
      projectionVersion: mcpRegistryVersion(tools),
      projectTools,
      reprojection: 0,
      userId,
    };
    this.#sessions.set(id, session);
    if (generation !== this.#generation) {
      // A publish started while `tools` were projected and could not see this
      // session yet, so `tools` can predate the change it announced.
      detached(
        this.#reprojectWithinDeadline(id, session),
        "mcp.tool-freshness-register",
      );
    }
    return () => {
      if (this.#sessions.get(id) === session) {
        this.#sessions.delete(id);
      }
    };
  }

  async publish({
    organizationId,
    userId,
  }: {
    organizationId: string;
    userId?: string | undefined;
  }): Promise<void> {
    this.#generation += 1;
    const entries = [...this.#sessions.entries()].filter(
      ([, session]) =>
        session.organizationId === organizationId &&
        (userId === undefined || session.userId === userId),
    );
    for (
      let offset = 0;
      offset < entries.length;
      offset += this.#notificationFanOut
    ) {
      const batch = entries.slice(offset, offset + this.#notificationFanOut);
      await Promise.all(
        batch.map(
          async ([id, session]) =>
            await this.#reprojectWithinDeadline(id, session),
        ),
      );
    }
  }

  async #close(session: LiveToolSession): Promise<void> {
    try {
      await session.close();
    } catch (error) {
      this.#reportError(error, "close_session");
    }
  }

  /**
   * Never rejects and never holds its caller past the deadline. A session
   * that misses it is reported and left to finish on its own; a stale late
   * result is still discarded by the reprojection sequence.
   */
  async #reprojectWithinDeadline(
    id: string,
    session: LiveToolSession,
  ): Promise<void> {
    try {
      await withTimeout(async () => await this.#reproject(id, session), {
        label: "MCP session tool reprojection",
        timeoutMs: this.#reprojectionDeadlineMs,
      });
    } catch (error) {
      this.#reportError(error, "reproject_session");
    }
  }

  async #reproject(id: string, session: LiveToolSession): Promise<void> {
    session.reprojection += 1;
    const reprojection = session.reprojection;
    const tools = await session.projectTools();
    // Overlapping publishes can resolve out of order; only the newest
    // reprojection of a still-registered session may move its version.
    if (
      reprojection !== session.reprojection ||
      this.#sessions.get(id) !== session
    ) {
      return;
    }
    const nextVersion = mcpRegistryVersion(tools);
    if (nextVersion === session.projectionVersion) {
      return;
    }
    session.projectionVersion = nextVersion;
    await session.notifyToolsChanged();
  }

  /** Test-only visibility for lifecycle assertions. */
  get size(): number {
    return this.#sessions.size;
  }
}

const reportMcpToolFreshnessError: ReportMcpToolFreshnessError = (
  error,
  operation,
) => {
  captureError(
    error,
    handlerErrorContext(`mcp.toolFreshness.${operation}`, {
      operation,
      phase: "tool_freshness",
      source: "mcp",
    }),
  );
};

let registry: McpToolFreshnessRegistry | undefined;

/** Module-owned registry shared by every MCP request and writer. */
export const getMcpToolFreshnessRegistry = (): McpToolFreshnessRegistry => {
  registry ??= new McpToolFreshnessRegistry({
    reportError: reportMcpToolFreshnessError,
  });
  return registry;
};

// Live sessions are held per API replica; a change written on another replica
// reaches this one's sessions through the shared broadcast channel.
registerMcpToolProjectionDelivery((identity) => {
  detached(
    getMcpToolFreshnessRegistry().publish(identity),
    "mcp.replica-tool-projection",
  );
});

/** Reprojects only sessions whose caller access can have changed. */
export const publishMcpToolProjectionChange = async (
  identity: McpToolProjectionIdentity,
): Promise<void> => {
  announceMcpToolProjectionChange(identity);
  await getMcpToolFreshnessRegistry().publish(identity);
};
