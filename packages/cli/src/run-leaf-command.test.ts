import { describe, expect, test } from "bun:test";

import type { FlagSpec, LeafCommandSpec } from "./route-types.js";
import { buildArgsFromFlags, flagKey } from "./run-leaf-command.js";

const specWith = (flags: readonly FlagSpec[]): LeafCommandSpec => ({
  commandPath: ["x", "y"],
  toolName: "x",
  flags,
  inputOnly: [],
  paginated: false,
  windowedText: false,
  destructive: false,
  inputSchema: { type: "object", properties: {} },
});

const stringFlag = (prop: string, required = false): FlagSpec => ({
  flag: `--${prop.replace(/_/gu, "-")}`,
  prop,
  kind: "string",
  required,
  repeatable: false,
});

describe("buildArgsFromFlags (S3)", () => {
  test("nullable-string literal `null` clears to JSON null", async () => {
    const spec = specWith([
      {
        flag: "--first-name",
        prop: "first_name",
        kind: "nullable-string",
        required: false,
        repeatable: false,
      },
    ]);
    const result = await buildArgsFromFlags(spec, {
      [flagKey({ prop: "first_name" })]: "null",
    });
    expect(result).toEqual({ ok: true, args: { first_name: null } });
  });

  test("nullable-string keeps a real string value", async () => {
    const spec = specWith([
      {
        flag: "--first-name",
        prop: "first_name",
        kind: "nullable-string",
        required: false,
        repeatable: false,
      },
    ]);
    const result = await buildArgsFromFlags(spec, { firstName: "Ada" });
    expect(result).toEqual({ ok: true, args: { first_name: "Ada" } });
  });

  test("enum rejects an out-of-set value", async () => {
    const spec = specWith([
      {
        flag: "--type",
        prop: "type",
        kind: "enum",
        enum: ["person", "org"],
        required: false,
        repeatable: false,
      },
    ]);
    const bad = await buildArgsFromFlags(spec, { type: "robot" });
    expect(bad.ok).toBe(false);
    const good = await buildArgsFromFlags(spec, { type: "person" });
    expect(good).toEqual({ ok: true, args: { type: "person" } });
  });

  test("int enforces min/max and accepts a negative parsed via `=`", async () => {
    const spec = specWith([
      {
        flag: "--padding",
        prop: "padding",
        kind: "int",
        min: 1,
        max: 6,
        required: false,
        repeatable: false,
      },
    ]);
    expect((await buildArgsFromFlags(spec, { padding: "9" })).ok).toBe(false);
    // A negative value is parsed (not rejected as non-int) then min-checked.
    const neg = await buildArgsFromFlags(spec, { padding: "-5" });
    expect(neg.ok).toBe(false);
    if (!neg.ok) {
      expect(neg.message).toContain(">= 1");
    }
    expect(await buildArgsFromFlags(spec, { padding: "3" })).toEqual({
      ok: true,
      args: { padding: 3 },
    });
  });

  test("repeatable arrays accumulate without comma-splitting", async () => {
    const spec = specWith([
      {
        flag: "--tag",
        prop: "tags",
        kind: "string-array",
        required: false,
        repeatable: true,
      },
    ]);
    const result = await buildArgsFromFlags(spec, { tags: ["a", "b"] });
    expect(result).toEqual({ ok: true, args: { tags: ["a", "b"] } });
  });

  test("a missing required flag is a usage error", async () => {
    const spec = specWith([stringFlag("matter_id", true)]);
    const result = await buildArgsFromFlags(spec, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("--matter-id");
    }
  });

  test("a leading literal @ is escaped as @@", async () => {
    const spec = specWith([stringFlag("name")]);
    const result = await buildArgsFromFlags(spec, { name: "@@handle" });
    expect(result).toEqual({ ok: true, args: { name: "@handle" } });
  });
});
