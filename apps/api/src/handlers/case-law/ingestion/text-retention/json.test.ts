import { describe, expect, test } from "bun:test";

import { compareRetention } from "./compare";
import { readJsonText } from "./json";

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

describe("declared JSON source text", () => {
  test("keeps repeated text and fallback fields without treating metadata as decision text", () => {
    const raw = bytes({
      paragraphs: [{ text: "repeat" }, { text: "repeat" }],
      fallback: "unstructured",
      docket: "not text",
    });
    const output = readJsonText({
      raw,
      fields: [
        { path: ["paragraphs", "*", "text"], format: "text" },
        { path: ["fallback"], format: "text" },
      ],
    }).unwrap().text;
    expect(
      compareRetention({
        source: "repeat repeat unstructured",
        output,
      }).unwrap(),
    ).toMatchObject({ defect: null });
    expect(output).not.toContain("not text");
  });

  test("nested HTML reads unknown children and loose text independently", () => {
    const output = readJsonText({
      raw: bytes({ body: "<div>loose <unknown>child</unknown></div>" }),
      fields: [{ path: ["body"], format: "html" }],
    }).unwrap().text;
    expect(
      compareRetention({ source: "loose child", output }).unwrap(),
    ).toMatchObject({ defect: null });
  });

  test("malformed or missing text cannot turn into an empty clean baseline", () => {
    for (const raw of [
      bytes({}),
      bytes({ body: 42 }),
      new TextEncoder().encode("{"),
    ]) {
      expect(
        readJsonText({
          raw,
          fields: [{ path: ["body"], format: "text" }],
        }).unwrapErr().reason,
      ).toBe("malformed");
    }
    expect(
      readJsonText({ raw: bytes({}), fields: [] }).unwrapErr().reason,
    ).toBe("malformed");
  });
});
