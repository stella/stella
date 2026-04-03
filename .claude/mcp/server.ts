import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SOURCES: Record<string, string> = {
  Elysia: "https://elysiajs.com/llms.txt",
  Drizzle: "https://orm.drizzle.team/llms.txt",
  TanStack: "https://tanstack.com/llms.txt",
  React: "https://react.dev/llms.txt",
  Valibot: "https://valibot.dev/llms.txt",
  Zod: "https://zod.dev/llms.txt",
  TipTap: "https://tiptap.dev/llms.txt",
  Bun: "https://bun.sh/llms.txt",
  BetterAuth: "https://www.better-auth.com/llms.txt",
  Turborepo: "https://turborepo.dev/llms.txt",
  Rivet: "https://rivet.dev/llms.txt",
  PostHog: "https://posthog.com/llms.txt",
  Zustand: "https://zustand.docs.pmnd.rs/llms.txt",
  Oxlint: "https://oxc.rs/llms.txt",
};

const server = new McpServer({
  name: "stella-docs",
  version: "1.0.0",
});

server.tool(
  "list_doc_sources",
  "List available library documentation sources",
  () => ({
    content: Object.entries(SOURCES).map(([name, url]) => ({
      type: "text" as const,
      text: `${name}: ${url}`,
    })),
  }),
);

const ALLOWED_HOSTS = new Set(
  Object.values(SOURCES).map((u) => new URL(u).hostname),
);

server.tool(
  "fetch_docs",
  "Fetch a llms.txt index or a specific doc page URL",
  { url: z.string().url() },
  async ({ url }) => {
    const host = new URL(url).hostname;
    if (!ALLOWED_HOSTS.has(host)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Blocked: ${host} is not a configured doc source`,
          },
        ],
        isError: true,
      };
    }
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${res.status} ${res.statusText}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: await res.text() }],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to fetch ${url}: ${message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
