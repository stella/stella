import type { Tool } from "@modelcontextprotocol/server";

import { mcpRegistryVersion } from "@/api/mcp/tool-versions";

const MAX_NOTIFICATION_FAN_OUT = 16;
const MAX_LIVE_TOOL_SESSIONS = 1024;

type LiveToolSession = {
  notifyToolsChanged: () => Promise<void> | void;
  organizationId: string;
  projectionVersion: string;
  projectTools: () => Promise<readonly Tool[]>;
  userId: string;
};

/**
 * Tracks the last projection shown to each live client. Writers can publish a
 * new projection after admission or feature-enrolment changes; unchanged
 * clients are skipped and notification failures are isolated from the write.
 */
export class McpToolFreshnessRegistry {
  readonly #sessions = new Map<string, LiveToolSession>();

  register({
    id,
    notifyToolsChanged,
    organizationId,
    projectTools,
    tools,
    userId,
  }: {
    id: string;
    notifyToolsChanged: LiveToolSession["notifyToolsChanged"];
    organizationId: string;
    projectTools: LiveToolSession["projectTools"];
    tools: readonly Tool[];
    userId: string;
  }): () => void {
    if (this.#sessions.size >= MAX_LIVE_TOOL_SESSIONS) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest !== undefined) {
        this.#sessions.delete(oldest);
      }
    }
    this.#sessions.set(id, {
      notifyToolsChanged,
      organizationId,
      projectionVersion: mcpRegistryVersion(tools),
      projectTools,
      userId,
    });
    return () => {
      this.#sessions.delete(id);
    };
  }

  async publish({
    organizationId,
    userId,
  }: {
    organizationId: string;
    userId?: string;
  }): Promise<void> {
    const entries = [...this.#sessions.entries()].filter(
      ([, session]) =>
        session.organizationId === organizationId &&
        (userId === undefined || session.userId === userId),
    );
    for (
      let offset = 0;
      offset < entries.length;
      offset += MAX_NOTIFICATION_FAN_OUT
    ) {
      const batch = entries.slice(offset, offset + MAX_NOTIFICATION_FAN_OUT);
      await Promise.allSettled(
        batch.map(async ([, session]) => {
          const nextVersion = mcpRegistryVersion(await session.projectTools());
          if (nextVersion === session.projectionVersion) {
            return;
          }
          session.projectionVersion = nextVersion;
          await session.notifyToolsChanged();
        }),
      );
    }
  }

  /** Test-only visibility for lifecycle assertions. */
  get size(): number {
    return this.#sessions.size;
  }
}

let registry: McpToolFreshnessRegistry | undefined;

/** Module-owned registry shared by every MCP request and writer. */
export const getMcpToolFreshnessRegistry = (): McpToolFreshnessRegistry => {
  registry ??= new McpToolFreshnessRegistry();
  return registry;
};

/** Reprojects only sessions whose caller access can have changed. */
export const publishMcpToolProjectionChange = async (identity: {
  organizationId: string;
  userId?: string;
}): Promise<void> => {
  await getMcpToolFreshnessRegistry().publish(identity);
};
