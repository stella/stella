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
              anyOf: [{ type: "string", format: "date" }, { type: "null" }],
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
          hint: '"1,234" reads as 1234 with "," grouping the thousands, or as 1.234 with "," as the decimal mark. Send 1234 or 1.234 as a JSON number.',
        },
        {
          path: "due",
          received: '"01/02/2026"',
          expected: "a calendar date",
          hint: 'That reads as 2026-02-01 with the day first, or 2026-01-02 with the month first. Send "2026-02-01" or "2026-01-02".',
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

  test("normalizes applicable union branches and preserves nullable enums", () => {
    expect(
      normalizeAgentInput({
        schema: {
          type: "object",
          properties: {
            nullable: {
              anyOf: [{ const: "primary", type: "string" }, { type: "null" }],
            },
            flexible: {
              anyOf: [
                { type: "string" },
                { type: "string", enum: ["open", "closed"] },
              ],
            },
          },
        },
        value: { nullable: null, flexible: " CLOSED " },
      }),
    ).toMatchObject({
      ok: true,
      value: { nullable: null, flexible: "closed" },
    });
  });

  test("normalizes values selected by pattern properties", () => {
    expect(
      normalizeAgentInput({
        schema: {
          type: "object",
          patternProperties: {
            "^clause-": {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
                level: { type: "integer" },
              },
            },
          },
        },
        value: {
          "clause-a": { enabled: "ano", level: "1 000" },
          untouched: { enabled: "ano", level: "1 000" },
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        "clause-a": { enabled: true, level: 1000 },
        untouched: { enabled: "ano", level: "1 000" },
      },
    });
  });

  test("lets a repair-owning handler preserve an invalid annotated value", () => {
    const schema = {
      [AGENT_INPUT_NORMALIZATION_KEY]: {
        kind: "date-format",
        invalidValueDisposition: "handler-owned",
      },
    };
    expect(normalizeAgentInput({ schema, value: "not a date format" })).toEqual(
      { ok: true, value: "not a date format", notes: [] },
    );
    expect(normalizeAgentInput({ schema, value: "en-GB-short" })).toMatchObject(
      {
        ok: true,
        value: { locale: "en-GB", style: "short" },
      },
    );
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

describe("placeholders, lists and bounded values at the schema walk", () => {
  const SEARCH_SCHEMA = {
    type: "object",
    properties: {
      query: { type: "string" },
      source_id: { type: "string", format: "uuid" },
      decision_id: { type: "string", format: "uuid" },
      court: {
        type: "string",
        [AGENT_INPUT_NORMALIZATION_KEY]: { kind: "filter" },
      },
      date_from: {
        type: "string",
        format: "date",
        [AGENT_INPUT_NORMALIZATION_KEY]: { kind: "date", bound: "start" },
      },
      date_to: {
        type: "string",
        format: "date",
        [AGENT_INPUT_NORMALIZATION_KEY]: { kind: "date", bound: "end" },
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        [AGENT_INPUT_NORMALIZATION_KEY]: { kind: "number", range: "clamp" },
      },
      queries: { type: "array", items: { type: "string" } },
      ids: { type: "array", items: { type: "string", format: "uuid" } },
      eli: { type: "string", [AGENT_INPUT_NORMALIZATION_KEY]: { kind: "eli" } },
    },
    required: ["decision_id"],
  } as const;

  const READERS = { eli: { hosts: { cz: "https://www.e-sbirka.cz" } } };
  const REAL_ID = "5f0c9d2e-8b7a-4c1d-9e3f-6a2b4c8d0e1f";

  test("an optional placeholder is dropped with a note, a real value kept", () => {
    const result = normalizeAgentInput({
      schema: SEARCH_SCHEMA,
      readers: READERS,
      value: {
        decision_id: REAL_ID.toUpperCase(),
        source_id: "00000000-0000-0000-0000-000000000000",
        court: "all",
        date_from: "0001-01-01",
        date_to: "2021-02",
        limit: "500",
        queries: "one phrasing, with a comma",
        ids: `${REAL_ID}, ${REAL_ID}`,
        eli: "/eli/cz/sb/2012/89",
      },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        decision_id: REAL_ID,
        date_to: "2021-02-28",
        limit: 20,
        queries: ["one phrasing, with a comma"],
        ids: [REAL_ID, REAL_ID],
        eli: "https://www.e-sbirka.cz/eli/cz/sb/2012/89",
      },
      notes: expect.any(Array),
    });
    // One note per value that was read rather than taken verbatim.
    expect(result.ok && result.notes).toHaveLength(9);
  });

  test("a placeholder where a value is required asks", () => {
    expect(
      normalizeAgentInput({
        schema: SEARCH_SCHEMA,
        value: { decision_id: "00000000-0000-0000-0000-000000000000" },
      }),
    ).toMatchObject({
      ok: false,
      issues: [{ path: "decision_id", expected: "a real value" }],
    });
  });

  test("a write asks about an optional placeholder instead of dropping it", () => {
    expect(
      normalizeAgentInput({
        schema: SEARCH_SCHEMA,
        placeholders: "ask",
        value: {
          decision_id: REAL_ID,
          source_id: "00000000-0000-0000-0000-000000000000",
        },
      }),
    ).toMatchObject({ ok: false, issues: [{ path: "source_id" }] });
  });

  test("a placeholder item in a list asks: a list has no optional slots", () => {
    expect(
      normalizeAgentInput({
        schema: SEARCH_SCHEMA,
        value: {
          decision_id: REAL_ID,
          ids: [REAL_ID, "00000000-0000-0000-0000-000000000000"],
        },
      }),
    ).toMatchObject({ ok: false, issues: [{ path: "ids.1" }] });
  });

  test("an ELI field is left as sent when the surface supplies no reader", () => {
    expect(
      normalizeAgentInput({
        schema: SEARCH_SCHEMA,
        value: { decision_id: REAL_ID, eli: "/eli/cz/sb/2012/89" },
      }),
    ).toMatchObject({ ok: true, value: { eli: "/eli/cz/sb/2012/89" } });
  });
});
