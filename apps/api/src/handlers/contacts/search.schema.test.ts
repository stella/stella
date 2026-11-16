import { afterAll, beforeEach, expect, test } from "bun:test";

import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";

import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveForTest } from "@/api/tests/helpers/test-server";

import listContacts from "./list";
import searchContacts from "./search";

let acceptedRequests = 0;
beforeEach(() => {
  acceptedRequests = 0;
});
const server = serveForTest(
  createHttpApp({
    middleware: [errorBoundary],
    routes: routes({
      "/contacts": {
        GET: defineEndpoint.public(
          { query: listContacts.config.query },
          ({ query }) => {
            acceptedRequests += 1;
            return query;
          },
        ),
      },
      "/contacts/search": {
        GET: defineEndpoint.public(
          { query: searchContacts.config.query },
          ({ query }) => {
            acceptedRequests += 1;
            return query;
          },
        ),
      },
    }),
  }),
);
afterAll(async () => {
  await server.stop();
});

const request = (path: string, q: string) =>
  server.fetch(
    new Request(`http://localhost${path}?${new URLSearchParams({ q })}`),
  );

test("both contact query boundaries accept the shared search limit without changing text", async () => {
  for (const path of ["/contacts", "/contacts/search"]) {
    for (const q of ["x".repeat(SEARCH_QUERY_MAX_LENGTH), "  أحمد %_  "]) {
      const response = await request(path, q);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ q });
    }
  }
});

test("queries past the shared limit never reach the endpoint", async () => {
  const before = acceptedRequests;
  for (const path of ["/contacts", "/contacts/search"]) {
    const response = await request(
      path,
      "x".repeat(SEARCH_QUERY_MAX_LENGTH + 1),
    );
    expect(response.status).toBe(422);
  }
  expect(acceptedRequests).toBe(before);
});

test("list accepts omitted or empty query while picker search still requires text", async () => {
  const omittedList = await server.fetch(
    new Request("http://localhost/contacts"),
  );
  expect(omittedList.status).toBe(200);
  expect(await omittedList.json()).toEqual({});
  const emptyList = await request("/contacts", "");
  expect(emptyList.status).toBe(200);
  expect(await emptyList.json()).toEqual({ q: "" });
  expect((await request("/contacts/search", "")).status).toBe(422);
  const omittedSearch = await server.fetch(
    new Request("http://localhost/contacts/search"),
  );
  expect(omittedSearch.status).toBe(422);
});
