import "@/api/register-schema-formats";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";

import { isApiDate } from "@/api/lib/json-schema/api-date";

const dateSchema = t.String({ format: "date" });

describe("API calendar date boundaries", () => {
  test("accepts exactly existing CE calendar days across month and leap-century boundaries", () => {
    const compiled = TypeCompiler.Compile(dateSchema);
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
          expect(compiled.Check(value)).toBe(expected);
          expect(Value.Check(dateSchema, value)).toBe(expected);
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
    expect(Value.Check(dateSchema, value)).toBe(false);
  });

  test.each([true, false])(
    "rejects invalid body and query dates before handlers (aot=%s)",
    async (aot) => {
      let calls = 0;
      const app = new Elysia({ aot })
        .patch(
          "/task",
          ({ body }) => {
            calls += 1;
            return body;
          },
          {
            body: t.Object({ dueDate: t.Optional(t.Nullable(dateSchema)) }),
          },
        )
        .get(
          "/overview",
          ({ query }) => {
            calls += 1;
            return query;
          },
          {
            query: t.Object({ agendaFrom: t.Optional(dateSchema) }),
          },
        );

      for (const value of [
        "2026-02-30",
        "2026-02-29",
        "1900-02-29",
        "2026-04-31",
        "0000-01-01",
        "2026-13-01",
        "2026-02-01T00:00:00Z",
      ]) {
        const bodyResponse = await app.handle(
          new Request("http://localhost/task", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dueDate: value }),
          }),
        );
        expect(bodyResponse.status).toBe(422);
        const queryResponse = await app.handle(
          new Request(
            `http://localhost/overview?agendaFrom=${encodeURIComponent(value)}`,
          ),
        );
        expect(queryResponse.status).toBe(422);
      }
      expect(calls).toBe(0);

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
        const response = await app.handle(
          new Request("http://localhost/task", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dueDate }),
          }),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(
          dueDate === undefined ? {} : { dueDate },
        );
      }
      const response = await app.handle(
        new Request("http://localhost/overview?agendaFrom=2028-02-29"),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ agendaFrom: "2028-02-29" });
      expect(calls).toBe(9);
    },
  );
});
