import { afterAll, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { apiDateSchema } from "@stll/api-contract/api-date";

import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
import { toJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveForTest } from "@/api/tests/helpers/test-server";

let calls = 0;
const server = serveForTest(
  createHttpApp({
    middleware: [errorBoundary],
    routes: routes({
      "/task": {
        PATCH: defineEndpoint.public(
          {
            body: v.object({
              dueDate: v.exactOptional(v.nullable(apiDateSchema)),
            }),
          },
          ({ body }) => {
            calls += 1;
            return body;
          },
        ),
      },
      "/overview": {
        GET: defineEndpoint.public(
          { query: v.object({ agendaFrom: v.optional(apiDateSchema) }) },
          ({ query }) => {
            calls += 1;
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

const patchTask = async (dueDate: string | null | undefined) =>
  await server.fetch(
    new Request("http://localhost/task", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dueDate }),
    }),
  );

describe("API calendar dates on the HTTP layer", () => {
  test("refuses impossible body and query dates before the handler runs", async () => {
    calls = 0;
    for (const value of [
      "2026-02-30",
      "2026-02-29",
      "1900-02-29",
      "2026-04-31",
      "0000-01-01",
      "2026-13-01",
      "2026-02-01T00:00:00Z",
    ]) {
      expect((await patchTask(value)).status).toBe(422);
      const queryResponse = await server.fetch(
        new Request(
          `http://localhost/overview?agendaFrom=${encodeURIComponent(value)}`,
        ),
      );
      expect(queryResponse.status).toBe(422);
    }
    expect(calls).toBe(0);
  });

  test("passes every existing day through unchanged", async () => {
    calls = 0;
    for (const dueDate of [
      "0001-01-01",
      "0099-12-31",
      "2000-02-29",
      "2028-02-29",
      "9999-12-31",
      "2011-12-30",
      null,
      undefined,
    ]) {
      const response = await patchTask(dueDate);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(
        dueDate === undefined ? {} : { dueDate },
      );
    }
    const response = await server.fetch(
      new Request("http://localhost/overview?agendaFrom=2028-02-29"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ agendaFrom: "2028-02-29" });
    expect(calls).toBe(9);
  });

  test("publishes the date shape while the calendar check runs only at parse", () => {
    expect(toJsonSchema(apiDateSchema)).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "string",
      format: "date",
    });
  });
});
