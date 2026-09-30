import type { ServerEntry } from "@tanstack/react-start/server-entry";
import { panic } from "better-result";
import { afterAll, expect, mock, test } from "bun:test";

Object.assign(import.meta.env, { VITE_PUBLIC_KNOWLEDGE_ENABLED: "false" });
const { env } = await import("@/env");
const { isPublicKnowledgeEnabled } =
  await import("@/lib/knowledge/public-knowledge-launch");
const originalFlag = env.VITE_PUBLIC_KNOWLEDGE_ENABLED;

const PUBLIC_POLICY = "public, max-age=300";
const DOCUMENT_POLICY = "private, no-store";
const cases = [
  {
    name: "bare HTML",
    path: "/knowledge",
    contentType: "text/html",
    status: 200,
    policy: DOCUMENT_POLICY,
  },
  {
    name: "charset",
    path: "/knowledge/",
    contentType: "text/html;charset=UTF-8",
    status: 200,
    policy: DOCUMENT_POLICY,
  },
  {
    name: "spacing",
    path: "/knowledge/templates/catalogue/general-legal/nda",
    contentType: "text/html ; charset=utf-8",
    status: 200,
    policy: DOCUMENT_POLICY,
  },
  {
    name: "mixed case",
    path: "/knowledge/tools?search=doc",
    contentType: "Text/HTML; charset=utf-8",
    status: 200,
    policy: DOCUMENT_POLICY,
  },
  {
    name: "uppercase",
    path: "/knowledge/tools",
    contentType: "TEXT/HTML ; CHARSET=UTF-8",
    status: 200,
    policy: DOCUMENT_POLICY,
  },
  {
    name: "non-HTML document path",
    path: "/knowledge/data",
    contentType: "application/json",
    status: 200,
    policy: PUBLIC_POLICY,
  },
  {
    name: "hyphen boundary",
    path: "/knowledge-x",
    contentType: "text/html",
    status: 200,
    policy: PUBLIC_POLICY,
  },
  {
    name: "word boundary",
    path: "/knowledgeable",
    contentType: "text/html",
    status: 200,
    policy: PUBLIC_POLICY,
  },
  {
    name: "static asset",
    path: "/assets/icon.svg",
    contentType: "image/svg+xml",
    status: 200,
    policy: PUBLIC_POLICY,
  },
  {
    name: "public API",
    path: "/api/public/knowledge/template-packs",
    contentType: "application/json",
    status: 200,
    policy: PUBLIC_POLICY,
  },
  {
    name: "HTML server error",
    path: "/knowledge/error",
    contentType: "Text/HTML",
    status: 500,
    policy: DOCUMENT_POLICY,
  },
  {
    name: "HTML not found",
    path: "/knowledge/missing",
    contentType: "text/html",
    status: 404,
    policy: DOCUMENT_POLICY,
  },
  {
    name: "redirect without HTML",
    path: "/knowledge/redirect",
    contentType: null,
    status: 302,
    policy: PUBLIC_POLICY,
  },
  {
    name: "redirect with HTML",
    path: "/knowledge/html-redirect",
    contentType: "text/html",
    status: 302,
    policy: DOCUMENT_POLICY,
  },
];
const REDIRECT_LOCATION = "/knowledge/tools";
const STATUS_TEXT = "Fixture response";

await mock.module("@tanstack/react-start/server-entry", () => ({
  createServerEntry: (entry: ServerEntry) => entry,
  default: {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const fixture =
        cases.find(({ name }) => name === url.searchParams.get("fixture")) ??
        panic("response fixture missing");
      const headers = new Headers({ "Cache-Control": PUBLIC_POLICY });
      if (fixture.contentType !== null) {
        headers.set("Content-Type", fixture.contentType);
      }
      if (fixture.status === 302) {
        headers.set("Location", REDIRECT_LOCATION);
      }
      const html = isPublicKnowledgeEnabled()
        ? "<html>catalogue</html>"
        : "<html>shell</html>";
      return await Promise.resolve(
        new Response(html, {
          headers,
          status: fixture.status,
          statusText: STATUS_TEXT,
        }),
      );
    },
  },
}));
const { default: server } = await import("@/server");

afterAll(() => {
  Object.assign(env, { VITE_PUBLIC_KNOWLEDGE_ENABLED: originalFlag });
});

for (const fixture of cases) {
  test.each([false, true])(
    `${fixture.name} response policy (enabled=%s)`,
    async (enabled) => {
      Object.assign(env, { VITE_PUBLIC_KNOWLEDGE_ENABLED: enabled });
      expect(isPublicKnowledgeEnabled()).toBe(enabled);
      const url = new URL(fixture.path, "https://stella.test");
      url.searchParams.set("fixture", fixture.name);
      const response = await server.fetch(new Request(url));
      expect(response.headers.get("Cache-Control")).toBe(fixture.policy);
      expect(response.status).toBe(fixture.status);
      expect(response.statusText).toBe(STATUS_TEXT);
      expect(response.headers.get("Location")).toBe(
        fixture.status === 302 ? REDIRECT_LOCATION : null,
      );
      expect(await response.text()).toBe(
        enabled ? "<html>catalogue</html>" : "<html>shell</html>",
      );
    },
  );
}
