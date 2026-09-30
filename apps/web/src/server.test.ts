import type { ServerEntry } from "@tanstack/react-start/server-entry";
import { afterAll, expect, mock, test } from "bun:test";

Object.assign(import.meta.env, { VITE_PUBLIC_KNOWLEDGE_ENABLED: "false" });
const { env } = await import("@/env");
const { isPublicKnowledgeEnabled } =
  await import("@/lib/knowledge/public-knowledge-launch");
const originalFlag = env.VITE_PUBLIC_KNOWLEDGE_ENABLED;

await mock.module("@tanstack/react-start/server-entry", () => ({
  createServerEntry: (entry: ServerEntry) => entry,
  default: {
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      const document =
        !path.startsWith("/assets/") && !path.startsWith("/api/");
      const html = isPublicKnowledgeEnabled()
        ? "<html>catalogue</html>"
        : "<html>shell</html>";
      return await Promise.resolve(
        new Response(document ? html : "asset", {
          headers: {
            "Content-Type": document
              ? "text/html; charset=utf-8"
              : "application/json",
            "Cache-Control": "public, max-age=300",
          },
        }),
      );
    },
  },
}));
const { default: server } = await import("@/server");

afterAll(() => {
  Object.assign(env, { VITE_PUBLIC_KNOWLEDGE_ENABLED: originalFlag });
});

test.each([false, true])(
  "Knowledge documents use an explicit response policy (enabled=%s)",
  async (enabled) => {
    Object.assign(env, { VITE_PUBLIC_KNOWLEDGE_ENABLED: enabled });
    expect(isPublicKnowledgeEnabled()).toBe(enabled);
    for (const path of [
      "/knowledge",
      "/knowledge/",
      "/knowledge/templates/catalogue/general-legal/nda",
    ]) {
      const response = await server.fetch(
        new Request(`https://stella.test${path}`),
      );
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.text()).toBe(
        enabled ? "<html>catalogue</html>" : "<html>shell</html>",
      );
    }
  },
);

test.each([
  "/assets/icon.svg",
  "/api/public/knowledge/template-packs",
  "/knowledgeable",
])("other responses retain their policy: %s", async (path) => {
  const response = await server.fetch(
    new Request(`https://stella.test${path}`),
  );
  expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
});
