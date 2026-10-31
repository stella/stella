import { expect, test } from "bun:test";

import getLinkIcon from "@/api/handlers/chat/link-icons/get";
import getExactIcon from "@/api/handlers/chat/link-icons/get-exact";
import type { LinkIconOutcome } from "@/api/handlers/chat/link-icons/outcome";
import { linkIconBody } from "@/api/handlers/chat/link-icons/response";
import { createHttpApp } from "@/api/http/app";
import { responseCachePolicy } from "@/api/http/cache";
import { routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveForTest } from "@/api/tests/helpers/test-server";

const serveIconRoutes = () =>
  serveForTest(
    createHttpApp({
      routes: routes({
        "/chat/link-icons/exact": { GET: getExactIcon },
        "/chat/link-icons/:hostname": { GET: getLinkIcon },
      }),
      middleware: [responseCachePolicy, errorBoundary],
    }),
  );

/** One route answering `outcome` the way the icon handlers do. */
const serveOutcome = (outcome: LinkIconOutcome) =>
  serveForTest(
    createHttpApp({
      routes: routes({
        "/": {
          GET: defineEndpoint.public({}, ({ set }) =>
            linkIconBody(outcome, set),
          ),
        },
      }),
      middleware: [responseCachePolicy, errorBoundary],
    }),
  );

test("favicon bytes require an authenticated chat principal", async () => {
  await using server = serveIconRoutes();
  const response = await server.fetch(
    new Request("http://localhost/chat/link-icons/example.com"),
  );
  expect(response.status).toBe(401);
});

test("exact icon bytes require an authenticated chat principal", async () => {
  await using server = serveIconRoutes();
  const response = await server.fetch(
    new Request(
      "http://localhost/chat/link-icons/exact?url=https%3A%2F%2Fexample.com%2Ficon.png",
    ),
  );
  expect(response.status).toBe(401);
});

test("missing icons have a typed fallback and private nosniff headers", async () => {
  await using server = serveOutcome({ type: "no-icon" });
  const response = await server.fetch(new Request("http://localhost/"));
  expect(await response.json()).toEqual({ type: "no-icon" });
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toContain("private");
});

test("verified bytes retain their MIME and never expose the origin URL", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  await using server = serveOutcome({
    type: "icon",
    icon: { bytes, mime: "image/png" },
  });
  const response = await server.fetch(new Request("http://localhost/"));
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.has("location")).toBe(false);
});

test("temporary icon refusals are never cached by the browser", async () => {
  await using server = serveOutcome({ type: "temporary" });
  const response = await server.fetch(new Request("http://localhost/"));
  expect(await response.json()).toEqual({ type: "temporary" });
  expect(response.headers.get("cache-control")).toContain("no-store");
});
