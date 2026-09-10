import { describe, expect, test } from "bun:test";

import {
  AGENT_INPUT_NORMALIZATION_KEY,
  agentInputNormalizationMetadata,
  normalizeAgentInput,
} from "./schema";

describe("normalizeAgentInput", () => {
  test("derives normalization recursively from JSON Schema", () => {
    expect(
      normalizeAgentInput({
        schema: {
          type: "object",
          properties: {
            active: { type: "boolean" },
            amount: { type: "number" },
            due: { type: "string", format: "date" },
            status: { type: "string", enum: ["open", "closed"] },
            action: {
              anyOf: [
                { const: "create", type: "string" },
                { const: "update", type: "string" },
              ],
            },
            rows: {
              type: "array",
              items: {
                type: "object",
                properties: { count: { type: "integer" } },
              },
            },
          },
        },
        value: {
          active: "ano",
          amount: "4 000",
          due: "1. 10. 2026",
          status: " CLOSED ",
          action: " UPDATE ",
          rows: [{ count: "1e3" }],
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        active: true,
        amount: 4000,
        due: "2026-10-01",
        status: "closed",
        action: "update",
        rows: [{ count: 1000 }],
      },
    });
  });

  test("returns field paths and correction hints for ambiguous values", () => {
    expect(
      normalizeAgentInput({
        schema: {
          type: "object",
          properties: {
            amount: { type: "number" },
            due: {
              anyOf: [
                { type: "string", format: "date" },
                { type: "null" },
              ],
            },
          },
        },
        value: { amount: "1,234", due: "01/02/2026" },
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "amount",
          received: '"1,234"',
          expected: "a number",
          hint:
            '"1,234" reads as 1234 with "," grouping the thousands, or as 1.234 with "," as the decimal mark. Send 1234 or 1.234 as a JSON number.',
        },
        {
          path: "due",
          received: '"01/02/2026"',
          expected: "a calendar date",
          hint:
            'That reads as 2026-02-01 with the day first, or 2026-01-02 with the month first. Send "2026-02-01" or "2026-01-02".',
        },
      ],
    });
  });

  test("leaves ordinary strings untouched", () => {
    const value = {
      reference: "  001,234 / 01-02-26  ",
      scalar: "not a number",
      nullable: null,
    };
    expect(
      normalizeAgentInput({
        schema: {
          type: "object",
          properties: {
            reference: { type: "string" },
            scalar: {
              anyOf: [{ type: "number" }, { type: "string" }],
            },
            nullable: { type: ["number", "null"] },
          },
        },
        value,
      }),
    ).toEqual({ ok: true, value, notes: [] });
  });

  test("derives schema guidance from the declared kind", () => {
    expect(
      agentInputNormalizationMetadata(
        { kind: "locale" },
        "Language used for suggestions.",
      ),
    ).toEqual({
      [AGENT_INPUT_NORMALIZATION_KEY]: { kind: "locale" },
      description:
        'Language used for suggestions. Use a BCP-47 language tag, for example "cs" or "en-GB".',
    });
  });

  test("reads explicit locale and date-format annotations", () => {
    expect(
      normalizeAgentInput({
        schema: {
          type: "object",
          properties: {
            locale: {
              type: "string",
              [AGENT_INPUT_NORMALIZATION_KEY]: { kind: "locale" },
            },
            date_format: {
              [AGENT_INPUT_NORMALIZATION_KEY]: { kind: "date-format" },
            },
          },
        },
        value: { locale: "cs_CZ", date_format: "en-GB-short" },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        locale: "cs-CZ",
        date_format: { locale: "en-GB", style: "short" },
      },
    });
  });

  test("follows local references and intersections", () => {
    expect(
      normalizeAgentInput({
        schema: {
          $defs: {
            dated: {
              type: "object",
              properties: { due: { type: "string", format: "date" } },
            },
          },
          allOf: [
            { $ref: "#/$defs/dated" },
            {
              type: "object",
              properties: { enabled: { type: ["boolean", "null"] } },
            },
          ],
        },
        value: { due: "1. 10. 2026", enabled: "ano" },
      }),
    ).toMatchObject({
      ok: true,
      value: { due: "2026-10-01", enabled: true },
    });
  });

  test("does not recurse forever through cyclic local references", () => {
    const value = {
      due: "1. 10. 2026",
      child: { due: "2. 10. 2026", child: {} },
    };
    expect(
      normalizeAgentInput({
        schema: {
          $defs: {
            node: {
              type: "object",
              properties: {
                due: { type: "string", format: "date" },
                child: { $ref: "#/$defs/node" },
              },
            },
          },
          $ref: "#/$defs/node",
        },
        value,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        due: "2026-10-01",
        child: { due: "2026-10-02", child: {} },
      },
    });
  });
});
