import { describe, expect, test } from "bun:test";

import { isClauseExportPayload } from "./import-export-schema";

const body = [{ text: "The Tenant shall indemnify the Landlord." }];

const payloadWith = (clauseExtra: Record<string, unknown>): unknown => ({
  version: 1,
  exportedAt: "2026-06-08T00:00:00.000Z",
  clauses: [{ title: "Indemnity", body, ...clauseExtra }],
});

describe("isClauseExportPayload — variants", () => {
  test("accepts a payload with no variants (backward compatible)", () => {
    expect(isClauseExportPayload(payloadWith({}))).toBe(true);
  });

  test("accepts well-formed variants", () => {
    expect(
      isClauseExportPayload(
        payloadWith({ variants: [{ label: "Short form", body }] }),
      ),
    ).toBe(true);
  });

  test("rejects a variant without a label", () => {
    expect(isClauseExportPayload(payloadWith({ variants: [{ body }] }))).toBe(
      false,
    );
  });

  test("rejects a variant with an invalid body", () => {
    expect(
      isClauseExportPayload(
        payloadWith({ variants: [{ label: "X", body: "not a body" }] }),
      ),
    ).toBe(false);
  });

  test("rejects a variant label over the varchar(256) column width", () => {
    expect(
      isClauseExportPayload(
        payloadWith({ variants: [{ label: "x".repeat(257), body }] }),
      ),
    ).toBe(false);
    expect(
      isClauseExportPayload(
        payloadWith({ variants: [{ label: "x".repeat(256), body }] }),
      ),
    ).toBe(true);
  });

  test("rejects a clause title over the varchar(256) column width", () => {
    expect(isClauseExportPayload(payloadWith({ title: "t".repeat(257) }))).toBe(
      false,
    );
  });
});
