import { describe, expect, test } from "bun:test";

import {
  normalizeInputAtBoundary,
  normalizeObjectInputAtBoundary,
} from "@/api/mcp/input-normalization";

describe("agent input dispatch normalization", () => {
  test("runs null omission before declared normalization", () => {
    expect(
      normalizeInputAtBoundary({
        path: "body",
        schema: {
          type: "object",
          properties: {
            amount: { type: "number" },
            due: { type: "string", format: "date" },
          },
        },
        value: { amount: null, due: "1. 10. 2026" },
      }),
    ).toMatchObject({
      ok: true,
      value: { due: "2026-10-01" },
    });
  });

  test("keeps security control booleans exact", () => {
    expect(
      normalizeObjectInputAtBoundary({
        exactProperties: ["confirm", "validate_only"],
        schema: {
          type: "object",
          properties: {
            confirm: { type: "boolean" },
            enabled: { type: "boolean" },
            validate_only: { type: "boolean" },
          },
        },
        value: {
          confirm: "yes",
          enabled: "yes",
          validate_only: "false",
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        confirm: "yes",
        enabled: true,
        validate_only: "false",
      },
    });
  });

  test("maps ambiguity to structured field issues and accepted formats", () => {
    expect(
      normalizeInputAtBoundary({
        schema: {
          type: "object",
          properties: { due: { type: "string", format: "date" } },
        },
        value: { due: "01/02/2026" },
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "due",
          message: '"01/02/2026" is not a calendar date.',
        },
      ],
      hint:
        'due: That reads as 2026-02-01 with the day first, or 2026-01-02 with the month first. Send "2026-02-01" or "2026-01-02".',
    });
  });
});
