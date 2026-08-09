import { describe, expect, test } from "bun:test";

import { encodeRfc3986Component } from "./rfc3986";

describe("RFC 3986 component encoding", () => {
  test("escapes every delimiter left unescaped by encodeURIComponent", () => {
    expect(encodeRfc3986Component("AZaz09-._~!'()*")).toBe(
      "AZaz09-._~%21%27%28%29%2A",
    );
  });
});
