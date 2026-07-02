import { describe, expect, test } from "bun:test";

import {
  classifyCoverage,
  computeBaselineDiff,
  isEndpointModule,
  parseExposure,
  toEndpointIdentifier,
} from "./mcp-coverage-guard";

describe("toEndpointIdentifier", () => {
  test("is the repo-relative path, stable regardless of root trailing slash", () => {
    const abs = "/repo/apps/api/src/handlers/contacts/read-by-id.ts";
    const expected = "apps/api/src/handlers/contacts/read-by-id.ts";
    expect(toEndpointIdentifier(abs, "/repo")).toBe(expected);
    expect(toEndpointIdentifier(abs, "/repo/")).toBe(expected);
  });

  test("returns the absolute path unchanged when it is outside the root", () => {
    expect(toEndpointIdentifier("/other/x.ts", "/repo")).toBe("/other/x.ts");
  });
});

describe("isEndpointModule", () => {
  test("accepts a { config, handler } definition", () => {
    expect(isEndpointModule({ config: { mcp: {} }, handler: () => {} })).toBe(
      true,
    );
  });

  test("rejects non-endpoint shapes", () => {
    expect(isEndpointModule(undefined)).toBe(false);
    expect(isEndpointModule({ config: {} })).toBe(false);
    expect(isEndpointModule({ handler: () => {} })).toBe(false);
    expect(isEndpointModule({ config: null, handler: () => {} })).toBe(false);
    expect(isEndpointModule({ config: {}, handler: "x" })).toBe(false);
  });
});

describe("parseExposure", () => {
  test("parses each disposition and rejects malformed ones", () => {
    expect(parseExposure({ type: "pending" })).toEqual({ type: "pending" });
    expect(parseExposure({ type: "tool", name: "search" })).toEqual({
      type: "tool",
      name: "search",
    });
    expect(parseExposure({ type: "covered", by: "search" })).toEqual({
      type: "covered",
      by: "search",
    });
    expect(parseExposure({ type: "internal", reason: "webhook" })).toEqual({
      type: "internal",
      reason: "webhook",
    });
    // Missing discriminant payloads are invalid, not silently accepted.
    expect(parseExposure({ type: "tool" }).type).toBe("invalid");
    expect(parseExposure({ type: "covered" }).type).toBe("invalid");
    expect(parseExposure({ type: "bogus" }).type).toBe("invalid");
  });

  test("distinguishes a missing mcp field (undefined) from a malformed one", () => {
    expect(parseExposure(undefined)).toEqual({
      type: "invalid",
      raw: undefined,
    });
    expect(parseExposure({ nope: true })).toEqual({
      type: "invalid",
      raw: { nope: true },
    });
  });
});

describe("computeBaselineDiff (ratchet)", () => {
  test("flags a newly-added pending endpoint absent from the baseline", () => {
    const diff = computeBaselineDiff({
      currentPending: ["a", "b"],
      baseline: ["a"],
    });
    expect(diff.newPending).toEqual(["b"]);
    expect(diff.stalePending).toEqual([]);
  });

  test("flags a stale baseline entry that is no longer pending", () => {
    const diff = computeBaselineDiff({
      currentPending: ["a"],
      baseline: ["a", "closed-gap"],
    });
    expect(diff.newPending).toEqual([]);
    expect(diff.stalePending).toEqual(["closed-gap"]);
  });

  test("clean when current pending exactly equals the baseline", () => {
    const diff = computeBaselineDiff({
      currentPending: ["b", "a"],
      baseline: ["a", "b"],
    });
    expect(diff.newPending).toEqual([]);
    expect(diff.stalePending).toEqual([]);
  });
});

describe("classifyCoverage", () => {
  const registryToolNames = ["search", "read_contact"] as const;

  test("passes when every tool is referenced and every reference is valid", () => {
    const issues = classifyCoverage({
      endpoints: [
        { id: "read.ts", exposure: { type: "tool", name: "read_contact" } },
        { id: "other.ts", exposure: { type: "pending" } },
        {
          id: "cov.ts",
          exposure: { type: "covered", by: "read_contact" },
        },
      ],
      registryToolNames,
      waivers: { search: "inline" },
    });
    expect(issues.missingMcp).toEqual([]);
    expect(issues.invalidExposure).toEqual([]);
    expect(issues.unknownToolNames).toEqual([]);
    expect(issues.orphanTools).toEqual([]);
    expect(issues.staleWaivers).toEqual([]);
  });

  test("flags an orphan tool that no endpoint references and no waiver covers", () => {
    const issues = classifyCoverage({
      endpoints: [
        { id: "read.ts", exposure: { type: "tool", name: "read_contact" } },
      ],
      registryToolNames,
      waivers: {},
    });
    expect(issues.orphanTools).toEqual(["search"]);
  });

  test("flags a tool/covered reference that is not in the registry", () => {
    const issues = classifyCoverage({
      endpoints: [
        { id: "a.ts", exposure: { type: "tool", name: "ghost" } },
        { id: "b.ts", exposure: { type: "covered", by: "phantom" } },
      ],
      registryToolNames,
      waivers: { search: "w", read_contact: "w" },
    });
    expect(issues.unknownToolNames).toEqual([
      { id: "a.ts", name: "ghost" },
      { id: "b.ts", name: "phantom" },
    ]);
  });

  test("flags a stale waiver naming a tool no longer in the registry", () => {
    const issues = classifyCoverage({
      endpoints: [
        { id: "a.ts", exposure: { type: "tool", name: "search" } },
        { id: "b.ts", exposure: { type: "tool", name: "read_contact" } },
      ],
      registryToolNames,
      waivers: { removed_tool: "stale" },
    });
    expect(issues.staleWaivers).toEqual(["removed_tool"]);
  });

  test("separates a missing mcp field from a malformed one", () => {
    const issues = classifyCoverage({
      endpoints: [
        { id: "missing.ts", exposure: { type: "invalid", raw: undefined } },
        { id: "malformed.ts", exposure: { type: "invalid", raw: { x: 1 } } },
      ],
      registryToolNames: [],
      waivers: {},
    });
    expect(issues.missingMcp).toEqual(["missing.ts"]);
    expect(issues.invalidExposure).toEqual(["malformed.ts"]);
  });
});
