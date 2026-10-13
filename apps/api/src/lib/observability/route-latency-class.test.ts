import { describe, expect, test } from "bun:test";

import {
  markAiRequest,
  runWithRequestIdScope,
} from "@/api/lib/observability/request-context";
import {
  requestClassAtCompletion,
  ROUTE_LATENCY_CLASSES,
} from "@/api/lib/observability/route-latency-class";
import api from "@/api/server";

describe("the route latency class census", () => {
  test("every registered route has exactly one explicit class with no stale declarations", () => {
    const registered = api.routes
      .map(({ method, path }) => `${method} ${path}`)
      .toSorted();
    expect(registered.length).toBeGreaterThan(100);
    expect(Object.keys(ROUTE_LATENCY_CLASSES).toSorted()).toEqual(registered);
  });
});

describe("the class a completed request is measured under", () => {
  test("uses each explicit decision, including ALL transport handlers", () => {
    runWithRequestIdScope(() => {
      for (const [key, declared] of Object.entries(ROUTE_LATENCY_CLASSES)) {
        const split = key.indexOf(" ");
        const method = key.slice(0, split);
        const route = key.slice(split + 1);
        expect(requestClassAtCompletion({ method, route })).toBe(declared);
        if (method === "ALL") {
          for (const actualMethod of ["GET", "POST", "DELETE", "OPTIONS"]) {
            expect(
              requestClassAtCompletion({ method: actualMethod, route }),
            ).toBe(declared);
          }
        }
      }
    });
  });

  test("keeps tool transports and stream setup outside CRUD before any model call", () => {
    runWithRequestIdScope(() => {
      for (const route of [
        "/mcp",
        "/mcp/advanced",
        "/mcp-law",
        "/mcp-documents",
        "/mcp-anonymized",
      ]) {
        expect(requestClassAtCompletion({ method: "POST", route })).toBe(
          "search",
        );
      }
      for (const route of [
        "/v1/notifications/events",
        "/v1/workspaces/:workspaceId/events",
        "/v1/desktop-edit-sessions/:sessionId/events",
        "/v1/chat/threads/:threadId/turns/:turnId/join",
      ]) {
        expect(requestClassAtCompletion({ method: "GET", route })).toBe(
          "stream",
        );
      }
      expect(
        requestClassAtCompletion({ method: "POST", route: "/v1/chat/" }),
      ).toBe("stream");
    });
  });

  test("keeps paginated event reads under the CRUD SLO", () => {
    runWithRequestIdScope(() => {
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
        const split = key.indexOf(" ");
        expect(
          requestClassAtCompletion({
            method: key.slice(0, split),
            route: key.slice(split + 1),
          }),
        ).toBe("ai");
      }
    });
  });

  test("rejects missing classifications even after a model call", () => {
    runWithRequestIdScope(() => {
      expect(() =>
        requestClassAtCompletion({ method: "GET", route: "/v1/new-route" }),
      ).toThrow("Missing route latency class");
      markAiRequest();
      expect(() =>
        requestClassAtCompletion({ method: "GET", route: "/v1/new-route" }),
      ).toThrow("Missing route latency class");
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
