import { describe, expect, test } from "bun:test";

import { readSourceRawField } from "./source-raw-field";

describe("source raw fields retain their declared representation", () => {
  test("JSON paths and verbatim text remain independent for the same part", () => {
    const json = ' { "items": [{"reference":"A"},{"reference":"B"}] }\n';
    const parts = { page: json };
    expect(
      readSourceRawField(parts, {
        type: "raw",
        part: "page",
        path: ["items", "*", "reference"],
        reason: "Publisher references",
      }),
    ).toEqual(["A", "B"]);
    expect(
      readSourceRawField(parts, {
        type: "rawText",
        part: "page",
        reason: "Original response",
      }),
    ).toBe(json);
    expect(
      readSourceRawField(parts, {
        type: "raw",
        part: "page",
        path: ["missing"],
        reason: "Missing publisher field",
      }),
    ).toBeUndefined();
  });

  test("HTML is returned verbatim only by an explicit text target", () => {
    const html =
      '<h1>Úřad</h1>\r\n<script type="application/ld+json">{"name":"Úřad"}</script>';
    expect(
      readSourceRawField(
        { page: html },
        { type: "rawText", part: "page", reason: "Publisher HTML" },
      ),
    ).toBe(html);
    expect(
      readSourceRawField(
        { page: html },
        { type: "raw", part: "page", path: [], reason: "Publisher JSON" },
      ),
    ).toBeUndefined();
  });

  test("missing parts stay missing for either representation", () => {
    expect(
      readSourceRawField(
        {},
        { type: "raw", part: "page", path: [], reason: "Publisher JSON" },
      ),
    ).toBeUndefined();
    expect(
      readSourceRawField(
        {},
        { type: "rawText", part: "page", reason: "Publisher HTML" },
      ),
    ).toBeUndefined();
  });
});
