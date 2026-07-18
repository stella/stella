import { describe, expect, test } from "bun:test";

import { parseCapabilityCatalog } from "./capability-catalog-load.js";

// `parseCapabilityCatalog` is the trust boundary between the committed catalog
// snapshot (produced api-side) and both consumers: build-time codegen (which
// panics on `null`) and the runtime registry-refresh path (which falls back to
// the baked-in tree on `null`). The invariant that matters is fail-closed: any
// value that is not exactly an array of well-shaped entries must yield `null`,
// never a half-parsed tree, and the projection must drop unknown keys so a
// malicious/newer snapshot cannot smuggle extra fields into the CLI.

const validEntry = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: "matters.list",
  handlerKind: "workspace",
  access: "read",
  destructive: false,
  scope: "stella:read",
  ...overrides,
});

describe("parseCapabilityCatalog fail-closed parsing", () => {
  test("returns null for values that are not an array", () => {
    expect(parseCapabilityCatalog(null)).toBeNull();
    expect(parseCapabilityCatalog(undefined)).toBeNull();
    expect(parseCapabilityCatalog("[]")).toBeNull();
    expect(parseCapabilityCatalog(validEntry())).toBeNull();
    expect(parseCapabilityCatalog(42)).toBeNull();
  });

  test("returns null when any entry is missing a required field", () => {
    const missingHandlerKind = validEntry();
    delete missingHandlerKind["handlerKind"];
    expect(parseCapabilityCatalog([missingHandlerKind])).toBeNull();

    const missingScope = validEntry();
    delete missingScope["scope"];
    expect(parseCapabilityCatalog([missingScope])).toBeNull();
  });

  test("returns null when an enum field carries an out-of-set value", () => {
    expect(
      parseCapabilityCatalog([validEntry({ handlerKind: "tenant" })]),
    ).toBeNull();
    expect(
      parseCapabilityCatalog([validEntry({ access: "admin" })]),
    ).toBeNull();
  });

  test("returns null when a typed field has the wrong primitive type", () => {
    expect(
      parseCapabilityCatalog([validEntry({ destructive: "yes" })]),
    ).toBeNull();
    expect(parseCapabilityCatalog([validEntry({ id: 123 })])).toBeNull();
  });

  test("one malformed entry fails the whole batch (no partial trees)", () => {
    // A single bad entry in an otherwise-valid array must reject the entire
    // snapshot rather than silently dropping the bad row.
    const result = parseCapabilityCatalog([
      validEntry({ id: "a" }),
      validEntry({ id: "b", access: "sideways" }),
      validEntry({ id: "c" }),
    ]);
    expect(result).toBeNull();
  });

  test("projects only known fields and drops unknown keys from a valid entry", () => {
    const parsed = parseCapabilityCatalog([
      validEntry({ id: "x", injected: "should-not-survive", nested: { a: 1 } }),
    ]);
    expect(parsed).not.toBeNull();
    const entry = parsed?.at(0);
    // The projection is an allowlist: extra keys present on the wire entry must
    // not leak into the CLI's in-memory catalog.
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "access",
      "destructive",
      "handlerKind",
      "id",
      "scope",
    ]);
  });

  test("absent optional fields are dropped, not defaulted", () => {
    const entry = parseCapabilityCatalog([validEntry()])?.at(0);
    expect(entry).toBeDefined();
    expect("requiresFileInput" in (entry ?? {})).toBe(false);
    expect("inputSchema" in (entry ?? {})).toBe(false);
    expect("inputSchemaTruncated" in (entry ?? {})).toBe(false);
  });

  test("projects inputSchema sub-parts, keeping only the present ones", () => {
    const entry = parseCapabilityCatalog([
      validEntry({
        inputSchema: { body: { type: "object" } },
        requiresFileInput: true,
      }),
    ])?.at(0);
    expect(entry?.requiresFileInput).toBe(true);
    expect(entry?.inputSchema).toEqual({ body: { type: "object" } });
    expect("params" in (entry?.inputSchema ?? {})).toBe(false);
    expect("query" in (entry?.inputSchema ?? {})).toBe(false);
  });

  test("accepts an empty array as a valid (empty) catalog", () => {
    expect(parseCapabilityCatalog([])).toEqual([]);
  });
});
