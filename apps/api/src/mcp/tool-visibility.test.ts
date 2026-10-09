import { describe, expect, test } from "bun:test";

import { isMcpToolVisibleTo } from "./tool-visibility";

describe("MCP tool audiences", () => {
  test("omitted visibility admits both audiences", () => {
    for (const definition of [
      {},
      { name: "tool-without-metadata" },
      { _meta: undefined },
      { _meta: { ui: {} } },
    ]) {
      expect(isMcpToolVisibleTo(definition, "model")).toBe(true);
      expect(isMcpToolVisibleTo(definition, "app")).toBe(true);
    }
  });

  test("invalid metadata fails instead of silently exposing tools", () => {
    for (const _meta of [null, "app", ["app"]]) {
      expect(() => isMcpToolVisibleTo({ _meta }, "model")).toThrow(
        "MCP tool metadata must be an object",
      );
    }
  });

  test("explicit audiences never admit the other audience", () => {
    for (const audience of ["app", "model"] as const) {
      const definition = { _meta: { ui: { visibility: [audience] } } };
      expect(isMcpToolVisibleTo(definition, audience)).toBe(true);
      expect(
        isMcpToolVisibleTo(definition, audience === "app" ? "model" : "app"),
      ).toBe(false);
    }
    const definition = { _meta: { ui: { visibility: ["model", "app"] } } };
    expect(isMcpToolVisibleTo(definition, "model")).toBe(true);
    expect(isMcpToolVisibleTo(definition, "app")).toBe(true);
  });

  test("invalid UI metadata fails instead of silently exposing tools", () => {
    for (const ui of [null, "app", ["app"]]) {
      expect(() => isMcpToolVisibleTo({ _meta: { ui } }, "model")).toThrow(
        "MCP tool UI metadata must be an object",
      );
    }
  });

  test("invalid audiences fail instead of silently exposing tools", () => {
    for (const visibility of [[], ["unknown"], "app", null]) {
      expect(() =>
        isMcpToolVisibleTo({ _meta: { ui: { visibility } } }, "model"),
      ).toThrow("MCP tool visibility must declare model or app audiences");
    }
  });
});
