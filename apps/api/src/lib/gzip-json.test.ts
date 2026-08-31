import { describe, expect, test } from "bun:test";

import { encodeGzipJson } from "./gzip-json";

describe("encodeGzipJson", () => {
  test("round-trips JSON deterministically", () => {
    const value = { decisions: [{ caseNumber: "1 A 2/2026" }], page: 1 };
    const first = encodeGzipJson(value);
    const second = encodeGzipJson(value);

    expect(first).toEqual(second);
    expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(first)))).toEqual(
      value,
    );
  });
});
