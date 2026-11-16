import { expect, test } from "bun:test";

import { writeRowSubPath } from "./repeatable-paths";
import { replaceResolvedValue } from "./resolved-values";
import type { RichPatchValue } from "./types";

const WRITERS = ["replaceResolvedValue", "writeRowSubPath"] as const;

test.each(WRITERS)(
  "%s preserves row identity, flat-key precedence and unrelated symbol metadata",
  (writer) => {
    const metadata = Symbol("fill metadata");
    const nested = { name: "nested name" };
    const values = {
      "party.name": "flat name",
      party: nested,
      [metadata]: "retained",
    };
    const alias = values;

    write({ writer, values, path: "party.name", value: "flat replacement" });
    expect(alias["party.name"]).toBe("flat replacement");
    expect(alias.party).toBe(nested);
    expect(nested.name).toBe("nested name");
    expect(alias[metadata]).toBe("retained");

    write({ writer, values, path: "party.title", value: "new nested title" });
    expect(Object.entries(nested)).toEqual([
      ["name", "nested name"],
      ["title", "new nested title"],
    ]);
    write({ writer, values, path: "missing.leaf", value: "unused" });
    expect(Object.hasOwn(values, "missing")).toBe(false);

    const richValue = { paragraphs: [] };
    write({ writer, values, path: "__proto__", value: richValue });
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
  WRITERS.flatMap((writer) =>
    ["party", "__proto__", "constructor"].map((field) => ({
      writer,
      field,
    })),
  ),
)(
  "$writer traverses only owned records through $field",
  ({ writer, field }) => {
    const shared = { retained: "shared value" };
    const prototype = { [field]: shared };
    const values = {};
    Object.setPrototypeOf(values, prototype);

    write({
      writer,
      values,
      path: `${field}.injected`,
      value: "must not reach the prototype",
    });
    expect(shared).toEqual({ retained: "shared value" });
    expect(Object.hasOwn(shared, "injected")).toBe(false);
    expect(Object.getPrototypeOf(values)).toBe(prototype);
    expect(Object.keys(values)).toEqual([]);

    const owned = { retained: "owned value" };
    const ownValues = { [field]: owned };
    write({
      writer,
      values: ownValues,
      path: `${field}.inserted`,
      value: "own replacement",
    });
    expect(Object.entries(owned)).toEqual([
      ["retained", "owned value"],
      ["inserted", "own replacement"],
    ]);
    expect(Object.getPrototypeOf(ownValues)).toBe(Object.prototype);
  },
);

type WriteOptions = {
  writer: (typeof WRITERS)[number];
  values: Record<string, unknown>;
  path: string;
  value: RichPatchValue;
};

const write = ({ writer, values, path, value }: WriteOptions): void => {
  switch (writer) {
    case "replaceResolvedValue":
      replaceResolvedValue(values, path, value);
      return;
    case "writeRowSubPath":
      writeRowSubPath(values, path, value);
  }
};
