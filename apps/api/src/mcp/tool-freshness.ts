import type { Tool } from "@modelcontextprotocol/server";

import { mcpRegistryVersion } from "@/api/mcp/tool-versions";

const MAX_NOTIFICATION_FAN_OUT = 16;

type LiveToolSession = {
  notifyToolsChanged: () => Promise<void> | void;
  projectionVersion: string;
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
    tools,
  }: {
    id: string;
    notifyToolsChanged: LiveToolSession["notifyToolsChanged"];
    tools: readonly Tool[];
  }): () => void {
    this.#sessions.set(id, {
      notifyToolsChanged,
      projectionVersion: mcpRegistryVersion(tools),
    });
    return () => {
      this.#sessions.delete(id);
    };
  }

  async publish(
    projectionFor: (sessionId: string) => Promise<readonly Tool[]>,
  ): Promise<void> {
    const entries = [...this.#sessions.entries()];
    for (
      let offset = 0;
      offset < entries.length;
      offset += MAX_NOTIFICATION_FAN_OUT
    ) {
      const batch = entries.slice(offset, offset + MAX_NOTIFICATION_FAN_OUT);
      await Promise.allSettled(
        batch.map(async ([id, session]) => {
          const nextVersion = mcpRegistryVersion(await projectionFor(id));
          if (nextVersion === session.projectionVersion) {
            return;
          }
          session.projectionVersion = nextVersion;
          await session.notifyToolsChanged();
        }),
      );
    }
  }
}
