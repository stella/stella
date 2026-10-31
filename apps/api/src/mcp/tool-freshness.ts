import type { Tool } from "@modelcontextprotocol/server";
import { Result } from "better-result";

import { mapWithConcurrency } from "@stll/concurrency";
import { createCoalescedDrain } from "@stll/concurrency/coalesced-drain";
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
/** How long one session's reprojection and notification may hold a publish. */
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

type Reprojection = ReturnType<typeof createCoalescedDrain>;

type LiveToolSession = {
  readonly close: () => Promise<void> | void;
  readonly notifyToolsChanged: () => Promise<void> | void;
  readonly organizationId: string;
  readonly projectTools: () => Promise<readonly Tool[]>;
  /**
   * Runs at most one projection for this session at a time. A request made
   * while one runs queues a single rerun, so the newest change is always
   * projected after it.
   */
  readonly reproject: Reprojection;
  readonly userId: string;
  /**
   * Version of the projection this client was last told about. Unknown until
   * the first projection after the stream opened lands: the client may hold a
   * list from before its stream existed.
   */
  projectionVersion: string | undefined;
};

export type McpToolFreshnessRegistration = {
  /** Settles once the opening projection has landed or missed its deadline. */
  opened: Promise<void>;
  unregister: () => void;
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
   * Registers a client's notification stream and projects its tools once.
   * The client may have listed its tools before the stream opened, and a
   * change can land in between, so that first projection always tells the
   * client to list again.
   */
  register({
    close,
    id,
    notifyToolsChanged,
    organizationId,
    projectTools,
    userId,
  }: {
    /** Ends the client's stream so its host reconnects. */
    close: LiveToolSession["close"];
    id: string;
    notifyToolsChanged: LiveToolSession["notifyToolsChanged"];
    organizationId: string;
    projectTools: LiveToolSession["projectTools"];
    userId: string;
  }): McpToolFreshnessRegistration {
    if (this.#sessions.size >= this.#capacity) {
      const oldest = this.#sessions.entries().next().value;
      if (oldest !== undefined) {
        const [oldestId, evicted] = oldest;
        this.#sessions.delete(oldestId);
        // An evicted client would stay connected without further signals.
        detached(this.#close(evicted), "mcp.tool-freshness-evict");
      }
    }
    const reproject: Reprojection = createCoalescedDrain(async () => {
      const current = this.#sessions.get(id);
      if (current?.reproject === reproject) {
        await this.#reproject(id, current);
      }
    });
    const session: LiveToolSession = {
      close,
      notifyToolsChanged,
      organizationId,
      projectionVersion: undefined,
      projectTools,
      reproject,
      userId,
    };
    this.#sessions.set(id, session);
    const opened = this.#reprojectWithinDeadline(session);
    detached(opened, "mcp.tool-freshness-register");
    return {
      opened,
      unregister: () => {
        if (this.#sessions.get(id) === session) {
          this.#sessions.delete(id);
        }
      },
    };
  }

  async publish({
    organizationId,
    userId,
  }: {
    organizationId: string;
    userId?: string | undefined;
  }): Promise<void> {
    const sessions = [...this.#sessions.values()].filter(
      (session) =>
        session.organizationId === organizationId &&
        (userId === undefined || session.userId === userId),
    );
    // A pool rather than fixed batches: a session stalled up to its deadline
    // holds one slot, not the start of every session queued behind it.
    await mapWithConcurrency({
      items: sessions,
      limit: this.#notificationFanOut,
      operation: async (session) =>
        await this.#reprojectWithinDeadline(session),
    });
  }

  async #close(session: LiveToolSession): Promise<void> {
    const closed = await Result.tryPromise({
      try: async () => {
        await session.close();
      },
      catch: (cause) => cause,
    });
    if (Result.isError(closed)) {
      this.#reportError(closed.error, "close_session");
    }
  }

  /**
   * Never rejects and never holds its caller past the deadline. A session
   * that misses it is reported and keeps its projection running; a change
   * published meanwhile is projected once that projection settles.
   */
  async #reprojectWithinDeadline(session: LiveToolSession): Promise<void> {
    const { completion } = session.reproject();
    const settled = await Result.tryPromise({
      try: async () =>
        await withTimeout(async () => await completion, {
          label: "MCP session tool reprojection",
          timeoutMs: this.#reprojectionDeadlineMs,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(settled)) {
      this.#reportError(settled.error, "reproject_session");
    }
  }

  async #reproject(id: string, session: LiveToolSession): Promise<void> {
    const projected = await Result.tryPromise({
      try: async () => await session.projectTools(),
      catch: (cause) => cause,
    });
    if (Result.isError(projected)) {
      this.#reportError(projected.error, "reproject_session");
      return;
    }
    if (this.#sessions.get(id) !== session) {
      return;
    }
    const nextVersion = mcpRegistryVersion(projected.value);
    if (nextVersion === session.projectionVersion) {
      return;
    }
    session.projectionVersion = nextVersion;
    const notified = await Result.tryPromise({
      try: async () => {
        await session.notifyToolsChanged();
      },
      catch: (cause) => cause,
    });
    if (Result.isError(notified)) {
      this.#reportError(notified.error, "reproject_session");
    }
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
  await Promise.all([
    announceMcpToolProjectionChange(identity),
    getMcpToolFreshnessRegistry().publish(identity),
  ]);
};
