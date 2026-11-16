import { afterAll, describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  apiDateSchema,
  apiDateTimeSchema,
  isApiDate,
} from "@stll/api-contract/api-date";

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

describe("API calendar date values", () => {
  test("accepts exactly existing CE calendar days across month and leap-century boundaries", () => {
    // Include the 0..99 Date constructor trap and Gregorian century exceptions.
    for (const year of [
      0, 1, 4, 99, 100, 399, 400, 1600, 1700, 1900, 2000, 2024, 2026, 2028,
      9999,
    ]) {
      for (let month = 0; month <= 13; month += 1) {
        for (let day = 0; day <= 32; day += 1) {
          const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          // Independent oracle: JavaScript normalizes nonexistent days, so only
          // a round trip with unchanged components represents a real date.
          const normalized = new Date(0);
          normalized.setUTCFullYear(year, month - 1, day);
          const expected =
            year > 0 &&
            normalized.getUTCFullYear() === year &&
            normalized.getUTCMonth() === month - 1 &&
            normalized.getUTCDate() === day;
          expect(isApiDate(value)).toBe(expected);
          expect(v.is(apiDateSchema, value)).toBe(expected);
        }
      }
    }
  });

  test.each([
    "2026-2-01",
    "2026-02-1",
    "2026/02/01",
    "01/02/2026",
    "2026-02-01T00:00:00Z",
    "+010000-01-01",
    "-0001-01-01",
    " 2026-02-01",
    "2026-02-01\n",
    '"2026-02-01"',
    "",
  ])("rejects noncanonical calendar date %j", (value) => {
    expect(v.is(apiDateSchema, value)).toBe(false);
  });
});

describe("API date-time storage boundaries", () => {
  test.each([
    "2026-10-23T10:00:00Z",
    "0001-01-01T00:00:00Z",
    "9999-12-31T23:59:59Z",
  ])("accepts the storable instant %s", (value) => {
    expect(v.is(apiDateTimeSchema, value)).toBe(true);
  });

  test.each([
    '"2026-10-23T10:00:00Z"',
    "0000-01-01T00:00:00Z",
    // A positive offset moves the instant back into UTC year 0.
    "0001-01-01T00:00:00+01:00",
    // A negative offset moves the instant forward into UTC year 10000.
    "9999-12-31T23:59:59-23:59",
  ])("rejects the unstorable instant %s", (value) => {
    expect(v.is(apiDateTimeSchema, value)).toBe(false);
  });

  test("publishes the date-time shape while the storage check runs only at parse", () => {
    expect(toJsonSchema(apiDateTimeSchema)).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "string",
      format: "date-time",
    });
  });
});
