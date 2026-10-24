import { expect, test } from "bun:test";

import { lintSingleRule, runSingleRule } from "./lint-single-rule.ts";

const plugin = "prefer-bun-native";

test("rejects Buffer#toString byte encodings", async () => {
  expect(
    await lintSingleRule(
      "no-buffer-string-encoding",
      [
        'bytes.toString("hex");',
        'Buffer.from(bytes).toString("base64");',
        "value.toString(`base64url`);",
        'value?.toString("hex");',
        'value["toString"]("base64");',
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([1, 2, 3, 4, 5]);
});

test("accepts native encoders, other encodings and radixes", async () => {
  expect(
    await lintSingleRule(
      "no-buffer-string-encoding",
      [
        "bytes.toHex();",
        "bytes.toBase64();",
        'buffer.toString("utf8");',
        "(255).toString(16);",
        "value.toString();",
        "value.toString(encoding);",
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([]);
});

test("rewrites each encoding to its native encoder", async () => {
  const fixed = await runSingleRule(
    "no-buffer-string-encoding",
    [
      'const a = bytes.toString("hex");',
      'const b = Buffer.from(text).toString("base64");',
      'const c = value?.toString("base64url");',
      'const d = value["toString"]("hex");',
    ].join("\n"),
    { plugin, fix: true },
  );
  expect(fixed.source).toBe(
    [
      "const a = bytes.toHex();",
      "const b = Buffer.from(text).toBase64();",
      'const c = value?.toBase64({ alphabet: "base64url", omitPadding: true });',
      'const d = value["toString"]("hex");',
    ].join("\n"),
  );
  // The computed key is left for a person, so it is still reported.
  expect(fixed.lines).toEqual([4]);
});

test("rejects Headers read through a JavaScript iterator", async () => {
  expect(
    await lintSingleRule(
      "no-headers-from-entries",
      [
        "Object.fromEntries(request.headers.entries());",
        "Object.fromEntries(response.headers);",
        "Object.fromEntries(new Headers(init).entries());",
        'Object.fromEntries(ctx.request["headers"].entries());',
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("accepts native Headers records and other iterables", async () => {
  expect(
    await lintSingleRule(
      "no-headers-from-entries",
      [
        "request.headers.toJSON();",
        "Object.fromEntries(map.entries());",
        "Object.fromEntries(searchParams);",
        "Object.fromEntries(headers.filter(Boolean));",
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([]);
});
