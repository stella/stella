import { afterAll, expect, test } from "bun:test";

import { CORRESPONDENCE_CHANNELS } from "@stll/api-contract/correspondence";

import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveForTest } from "@/api/tests/helpers/test-server";

import listCorrespondence from "./list";

const server = serveForTest(
  createHttpApp({
    middleware: [errorBoundary],
    routes: routes({
      "/correspondence": {
        GET: defineEndpoint.public(
          { query: listCorrespondence.config.query },
          ({ query }) => query,
        ),
      },
    }),
  }),
);
afterAll(async () => {
  await server.stop();
});

test("every correspondence channel survives HTTP query decoding alongside a numeric page limit", async () => {
  for (const channel of CORRESPONDENCE_CHANNELS) {
    const response = await server.fetch(
      new Request(`http://localhost/correspondence?channel=${channel}&limit=7`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ channel, limit: 7 });
  }
  const unfiltered = await server.fetch(
    new Request("http://localhost/correspondence"),
  );
  expect(unfiltered.status).toBe(200);
  expect(await unfiltered.json()).toEqual({});
});

test("unknown channels and invalid page limits are refused at the HTTP boundary", async () => {
  for (const query of [
    "channel=other",
    "limit=0",
    "limit=101",
    "limit=1.5",
    "limit=not-a-number",
  ]) {
    const response = await server.fetch(
      new Request(`http://localhost/correspondence?${query}`),
    );
    expect({ query, status: response.status }).toEqual({ query, status: 422 });
  }
});
