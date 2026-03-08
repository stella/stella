import { describe, expect, it } from "bun:test";

import { pickDefined } from "./pick-defined";

describe("pickDefined", () => {
  it("picks only defined values for specified keys", () => {
    const obj = { name: "Ada", email: undefined, color: "blue" };
    const result = pickDefined(obj, ["name", "email", "color"]);
    expect(result).toEqual({ name: "Ada", color: "blue" });
  });

  it("returns empty object when all specified keys are undefined", () => {
    const obj = { a: undefined, b: undefined };
    const result = pickDefined(obj, ["a", "b"]);
    expect(result).toEqual({});
  });

  it("excludes keys not in the pick list", () => {
    const obj = { name: "Ada", secret: "leaked" };
    const result = pickDefined(obj, ["name"]);
    expect(result).toEqual({ name: "Ada" });
    expect("secret" in result).toBe(false);
  });

  it("preserves null values (only filters undefined)", () => {
    const obj = { name: "Ada", nickname: null };
    const result = pickDefined(obj, ["name", "nickname"]);
    expect(result).toEqual({ name: "Ada", nickname: null });
  });

  it("preserves falsy values (0, false, empty string)", () => {
    const obj = { count: 0, active: false, label: "" };
    const result = pickDefined(obj, ["count", "active", "label"]);
    expect(result).toEqual({ count: 0, active: false, label: "" });
  });
});
