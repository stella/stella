import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertyTestTimeout } from "@stll/property-testing";

import { AGENT_INPUT_NORMALIZATION_KEY, normalizeAgentInput } from "./schema";

setDefaultTimeout(propertyTestTimeout(10_000));

const schema = {
  type: "object",
  properties: {
    active: { type: "boolean" },
    count: { type: "integer" },
    due: { type: "string", format: "date" },
    status: { type: "string", enum: ["open", "closed"] },
    words: { type: "array", items: { type: "string" } },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          level: { type: "integer" },
        },
      },
    },
    filter: {
      type: "string",
      [AGENT_INPUT_NORMALIZATION_KEY]: { kind: "filter" },
    },
  },
};

const inputArb = fc.record({
  active: fc.constantFrom(true, false, "ano", "ne", "YES", "off"),
  count: fc.integer().map(String),
  due: fc
    .date({
      min: new Date(Date.UTC(1900, 0, 1)),
      max: new Date(Date.UTC(2099, 11, 31)),
      noInvalidDate: true,
    })
    .map((date) => date.toISOString().slice(0, 10)),
  status: fc.constantFrom("open", "closed", " OPEN ", "Closed"),
  words: fc.oneof(fc.array(fc.string()), fc.string()),
  rows: fc.array(
    fc.record({
      enabled: fc.constantFrom(true, false, "ano", "ne"),
      level: fc.integer().map(String),
    }),
  ),
  filter: fc.constantFrom("all", "-", " court "),
});

describe("schema normalization", () => {
  test("normalized nested inputs are fixed points", () => {
    fc.assert(
      fc.property(inputArb, (value) => {
        const first = normalizeAgentInput({ schema, value });
        expect(first.ok).toBe(true);
        if (!first.ok) {
          return;
        }

        const second = normalizeAgentInput({ schema, value: first.value });
        expect(second).toEqual({ ok: true, value: first.value, notes: [] });
      }),
      propertyConfig({ numRuns: 150 }),
    );
  });

  test("integer fields retain their declared shape", () => {
    fc.assert(
      fc.property(fc.integer(), (value) => {
        for (const spelling of [value, String(value)]) {
          expect(
            normalizeAgentInput({
              schema: { type: "integer" },
              value: spelling,
            }),
          ).toMatchObject({ ok: true, value });
        }
      }),
      propertyConfig({ numRuns: 150 }),
    );

    fc.assert(
      fc.property(
        fc.double({ min: -1_000_000, max: 1_000_000, noNaN: true }),
        (value) => {
          fc.pre(!Number.isInteger(value));
          const result = normalizeAgentInput({
            schema: { type: "integer" },
            value,
          });
          expect(result.ok).toBe(false);
          expect(!result.ok && result.issues.at(0)?.expected).toBe(
            "a whole number",
          );
        },
      ),
      propertyConfig({ numRuns: 150 }),
    );
  });
});
