import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { generatedVisualInputSchema } from "@stll/api-contract/generated-visual";

import { prepareGeneratedVisual } from "./prepare";

const input = () =>
  v.parse(generatedVisualInputSchema, {
    title: "Revenue",
    html: "<p>revenue month amount</p>",
    data: { revenue: [{ month: "January", amount: 42 }] },
  });

describe("generated visual preparation", () => {
  test("retains only page-referenced data fields and literal links", () => {
    const source = input();
    const prepared = prepareGeneratedVisual(source);
    expect(prepared.isOk()).toBe(true);
    if (prepared.isOk()) {
      expect(prepared.value.data).toEqual(source.data);
      expect(prepared.value.links).toEqual([]);
      expect(prepared.value.literalLinks).toEqual([]);
    }
  });
  test("refuses unreferenced nested fields and permits literal page references", () => {
    const source = input();
    source.data = {
      revenue: [{ month: "January", amount: 42, note: "First month" }],
    };
    const unused = prepareGeneratedVisual(source);
    expect(unused.isErr()).toBe(true);
    if (unused.isErr()) {
      expect(unused.error.message).toContain("note");
    }
    source.html += "<p>note: First month</p>";
    expect(prepareGeneratedVisual(source).isOk()).toBe(true);
    expect(
      prepareGeneratedVisual({ ...source, data: { removed: 1 } }).isErr(),
    ).toBe(true);
  });
  test("refuses duplicate decision link identifiers", () => {
    const links = [{ id: "decision-one", decisionId: "case-one" }];
    expect(prepareGeneratedVisual({ ...input(), links }).isOk()).toBe(true);
    const duplicate = prepareGeneratedVisual({
      ...input(),
      links: [...links, ...links],
    });
    expect(duplicate.isErr()).toBe(true);
    if (duplicate.isErr()) {
      expect(duplicate.error.message).toContain("unique identifier");
    }
  });
});
