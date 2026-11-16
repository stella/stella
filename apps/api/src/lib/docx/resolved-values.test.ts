import { expect, test } from "bun:test";

import { writeRowSubPath } from "./repeatable-paths";
import { replaceResolvedValue } from "./resolved-values";

test.each(Object.entries({ replaceResolvedValue, writeRowSubPath }))(
  "%s preserves row identity, flat-key precedence and unrelated symbol metadata",
  (_name, write) => {
    const metadata = Symbol("fill metadata");
    const nested = { name: "nested name" };
    const values = {
      "party.name": "flat name",
      party: nested,
      [metadata]: "retained",
    };
    const alias = values;

    write(values, "party.name", "flat replacement");
    expect(alias["party.name"]).toBe("flat replacement");
    expect(alias.party).toBe(nested);
    expect(nested.name).toBe("nested name");
    expect(alias[metadata]).toBe("retained");

    write(values, "party.title", "new nested title");
    expect(Object.entries(nested)).toEqual([
      ["name", "nested name"],
      ["title", "new nested title"],
    ]);
    write(values, "missing.leaf", "unused");
    expect(Object.hasOwn(values, "missing")).toBe(false);

    const richValue = { paragraphs: [] };
    write(values, "__proto__", richValue);
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(values, "__proto__")).toEqual({
      value: richValue,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  },
);

test.each(
  Object.entries({ replaceResolvedValue, writeRowSubPath }).flatMap(
    ([name, write]) =>
      ["party", "__proto__", "constructor"].map((field) => ({
        name,
        write,
        field,
      })),
  ),
)("$name traverses only owned records through $field", ({ write, field }) => {
  const shared = { retained: "shared value" };
  const prototype = { [field]: shared };
  const values = {};
  Object.setPrototypeOf(values, prototype);

  write(values, `${field}.injected`, "must not reach the prototype");
  expect(shared).toEqual({ retained: "shared value" });
  expect(Object.hasOwn(shared, "injected")).toBe(false);
  expect(Object.getPrototypeOf(values)).toBe(prototype);
  expect(Object.keys(values)).toEqual([]);

  const owned = { retained: "owned value" };
  const ownValues = { [field]: owned };
  write(ownValues, `${field}.inserted`, "own replacement");
  expect(Object.entries(owned)).toEqual([
    ["retained", "owned value"],
    ["inserted", "own replacement"],
  ]);
  expect(Object.getPrototypeOf(ownValues)).toBe(Object.prototype);
});
