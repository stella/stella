import { describe, expect, test } from "bun:test";

import {
  classifyCoverage,
  computeBaselineDiff,
  enumerateModuleEndpoints,
  findHiddenEndpointMismatches,
  findStaleAllowlistEntries,
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
    expect(
      parseExposure({ type: "capability", reason: "billing_admin" }),
    ).toEqual({
      type: "capability",
      reason: "billing_admin",
    });
    expect(parseExposure({ type: "internal", reason: "webhook" })).toEqual({
      type: "internal",
      reason: "webhook",
    });
    // Missing discriminant payloads are invalid, not silently accepted.
    expect(parseExposure({ type: "tool" }).type).toBe("invalid");
    expect(parseExposure({ type: "covered" }).type).toBe("invalid");
    expect(parseExposure({ type: "capability" }).type).toBe("invalid");
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

  test("flags every pending endpoint once the baseline is empty", () => {
    const diff = computeBaselineDiff({
      currentPending: ["new-gap"],
      baseline: [],
    });
    expect(diff.newPending).toEqual(["new-gap"]);
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

describe("enumerateModuleEndpoints", () => {
  const endpoint = (mcp: unknown) => ({ config: { mcp }, handler: () => {} });

  test("records the default export under the plain module id", () => {
    const enumerated = enumerateModuleEndpoints(
      { default: endpoint({ type: "pending" }) },
      "m.ts",
    );
    expect(enumerated).toEqual([{ id: "m.ts", exposure: { type: "pending" } }]);
  });

  test("records named exports as id#exportName and ignores non-endpoints", () => {
    const enumerated = enumerateModuleEndpoints(
      {
        named: endpoint({ type: "pending" }),
        schema: { not: "an endpoint" },
      },
      "m.ts",
    );
    expect(enumerated).toEqual([
      { id: "m.ts#named", exposure: { type: "pending" } },
    ]);
  });

  test("dedupes an object exported as both default and a name under the default id", () => {
    const shared = endpoint({ type: "internal", reason: "webhook" });
    const enumerated = enumerateModuleEndpoints(
      {
        default: shared,
        primary: shared,
        other: endpoint({ type: "pending" }),
      },
      "m.ts",
    );
    expect(enumerated.map(({ id }) => id).sort()).toEqual([
      "m.ts",
      "m.ts#other",
    ]);
  });
});

describe("findHiddenEndpointMismatches", () => {
  test("flags a file whose call sites exceed its enumerable endpoints", () => {
    const mismatches = findHiddenEndpointMismatches({
      files: [{ id: "hidden.ts", callCount: 2, enumerableCount: 1 }],
      allowlist: {},
    });
    expect(mismatches).toEqual([
      { id: "hidden.ts", callCount: 2, enumerableCount: 1, allowed: 0 },
    ]);
  });

  test("passes an allowlisted inline file whose count matches", () => {
    expect(
      findHiddenEndpointMismatches({
        files: [{ id: "inline.ts", callCount: 5, enumerableCount: 0 }],
        allowlist: { "inline.ts": 5 },
      }),
    ).toEqual([]);
  });

  test("flags an allowlisted file with one extra inline endpoint", () => {
    const mismatches = findHiddenEndpointMismatches({
      files: [{ id: "inline.ts", callCount: 6, enumerableCount: 0 }],
      allowlist: { "inline.ts": 5 },
    });
    expect(mismatches).toEqual([
      { id: "inline.ts", callCount: 6, enumerableCount: 0, allowed: 5 },
    ]);
  });

  test("passes a plain endpoint file with one call and one enumerable export", () => {
    expect(
      findHiddenEndpointMismatches({
        files: [{ id: "read.ts", callCount: 1, enumerableCount: 1 }],
        allowlist: {},
      }),
    ).toEqual([]);
  });
});

describe("findStaleAllowlistEntries", () => {
  test("flags an allowlist entry whose file was not discovered", () => {
    expect(
      findStaleAllowlistEntries({
        files: [{ id: "live.ts", callCount: 3, enumerableCount: 0 }],
        allowlist: { "live.ts": 3, "gone.ts": 5 },
      }),
    ).toEqual(["gone.ts"]);
  });

  test("passes when every allowlist entry matches a discovered file", () => {
    expect(
      findStaleAllowlistEntries({
        files: [{ id: "inline.ts", callCount: 5, enumerableCount: 0 }],
        allowlist: { "inline.ts": 5 },
      }),
    ).toEqual([]);
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
        // A `capability` disposition is valid on its own: it is reached through
        // the generic capability path, so it needs no tool-name cross-check and
        // never orphans a tool.
        {
          id: "cap.ts",
          exposure: { type: "capability", reason: "billing_admin" },
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
