import { describe, expect, test } from "bun:test";

import { apiRoutes } from "@/api/api-routes";
import { HTTP_METHODS } from "@/api/http/route";
import {
  markAiRequest,
  runWithRequestIdScope,
} from "@/api/lib/observability/request-context";
import {
  requestClassAtCompletion,
  ROUTE_LATENCY_CLASSES,
} from "@/api/lib/observability/route-latency-class";

const registered = new Set(
  apiRoutes.map(({ method, path }) => `${method} ${path}`),
);

const MCP_TRANSPORTS = [
  "/mcp",
  "/mcp/advanced",
  "/mcp-law",
  "/mcp-documents",
  "/mcp-anonymized",
];

const STREAM_SETUP_ROUTES = [
  "GET /v1/notifications/events",
  "GET /v1/workspaces/:workspaceId/events",
  "GET /v1/desktop-edit-sessions/:sessionId/events",
  "GET /v1/chat/threads/:threadId/turns/:turnId/join",
  "POST /v1/chat",
];

const splitKey = (key: string) => {
  const split = key.indexOf(" ");
  return { method: key.slice(0, split), route: key.slice(split + 1) };
};

describe("the route latency class census", () => {
  test("every registered route has exactly one explicit class with no stale declarations", () => {
    expect(registered.size).toBeGreaterThan(100);
    expect(Object.keys(ROUTE_LATENCY_CLASSES).toSorted()).toEqual(
      [...registered].toSorted(),
    );
  });

  test("declares classes only under methods the route table mounts", () => {
    const methods = new Set<string>(HTTP_METHODS);
    expect(
      Object.keys(ROUTE_LATENCY_CLASSES).filter(
        (key) => !methods.has(splitKey(key).method),
      ),
    ).toEqual([]);
  });
});

describe("the class a completed request is measured under", () => {
  test("uses each explicit decision", () => {
    runWithRequestIdScope(() => {
      for (const [key, declared] of Object.entries(ROUTE_LATENCY_CLASSES)) {
        expect(requestClassAtCompletion(splitKey(key))).toBe(declared);
      }
    });
  });

  test("keeps tool transports and stream setup outside CRUD before any model call", () => {
    runWithRequestIdScope(() => {
      for (const route of MCP_TRANSPORTS) {
        for (const method of ["GET", "POST", "DELETE"]) {
          expect(registered.has(`${method} ${route}`)).toBe(true);
          expect(requestClassAtCompletion({ method, route })).toBe("search");
        }
      }
      for (const key of STREAM_SETUP_ROUTES) {
        expect(registered.has(key)).toBe(true);
        expect(requestClassAtCompletion(splitKey(key))).toBe("stream");
      }
    });
  });

  test("keeps paginated event reads under the CRUD SLO", () => {
    runWithRequestIdScope(() => {
      expect(registered.has("GET /v1/contacts/sanctions/events")).toBe(true);
      expect(
        requestClassAtCompletion({
          method: "GET",
          route: "/v1/contacts/sanctions/events",
        }),
      ).toBe("crud");
    });
  });

  test("is ai once the request reached a model for every declared class", () => {
    runWithRequestIdScope(() => {
      markAiRequest();
      for (const key of Object.keys(ROUTE_LATENCY_CLASSES)) {
        expect(requestClassAtCompletion(splitKey(key))).toBe("ai");
      }
    });
  });

  test("measures a route outside the served API without failing the request", () => {
    // Only an app built from part of the route table reaches this: the census
    // above fails CI for any route the API itself mounts without a declaration.
    runWithRequestIdScope(() => {
      expect(registered.has("POST /search")).toBe(false);
      expect(
        requestClassAtCompletion({ method: "POST", route: "/search" }),
      ).toBe("crud");
      markAiRequest();
      expect(
        requestClassAtCompletion({ method: "POST", route: "/search" }),
      ).toBe("ai");
    });
  });

  test("measures unmatched requests separately from registered decisions", () => {
    runWithRequestIdScope(() => {
      expect(
        requestClassAtCompletion({ method: "GET", route: "unmatched" }),
      ).toBe("crud");
    });
  });
});
