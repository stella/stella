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
  inputSchema: {},
  transport: { type: "json" },
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

    // `transport` is total on the wire: an entry without it cannot be read as
    // "JSON, apparently", which would open a file capability to the CLI.
    const missingTransport = validEntry();
    delete missingTransport["transport"];
    expect(parseCapabilityCatalog([missingTransport])).toBeNull();
  });

  test("returns null for an unknown or malformed transport disposition", () => {
    expect(
      parseCapabilityCatalog([
        validEntry({ transport: { type: "presigned" } }),
      ]),
    ).toBeNull();
    // A file-input leg without its field/required pair cannot say whether the
    // capability keeps a fileless mode, so it must fail closed.
    expect(
      parseCapabilityCatalog([
        validEntry({ transport: { type: "file-input", input: {} } }),
      ]),
    ).toBeNull();
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
      "inputSchema",
      "scope",
      "transport",
    ]);
  });

  test("rejects an entry with no inputSchema at all", () => {
    // Every capability carries a complete (`$defs`-compacted) input schema
    // since the exporter stopped dropping oversize ones. An entry without one
    // is a stale artifact, not something to degrade around.
    const { inputSchema: _dropped, ...withoutSchema } = validEntry();
    expect(parseCapabilityCatalog([withoutSchema])).toBeNull();
  });

  test("carries a compacted schema through unchanged", () => {
    // The loader is the only path a compacted schema takes from the committed
    // artifact to the expander. Dropping `$defs`, or any one of the three
    // parts, would leave a leaf whose refs resolve to nothing.
    const inputSchema = {
      $defs: {
        s_0123456789ab: {
          type: "object",
          properties: { operator: { type: "string" }, value: {} },
          required: ["operator"],
        },
      },
      body: {
        type: "object",
        properties: {
          where: { $ref: "#/$defs/s_0123456789ab" },
          having: { $ref: "#/$defs/s_0123456789ab" },
        },
      },
      params: {
        type: "object",
        properties: { workspaceId: { type: "string" } },
      },
      query: { type: "object", properties: { limit: { type: "number" } } },
    };

    expect(
      parseCapabilityCatalog([validEntry({ inputSchema })])?.at(0)?.inputSchema,
    ).toEqual(inputSchema);
  });

  test("absent optional fields are dropped, not defaulted", () => {
    const entry = parseCapabilityCatalog([validEntry()])?.at(0);
    expect(entry).toBeDefined();
    expect("description" in (entry ?? {})).toBe(false);
  });

  test("narrows the transport to the discriminant and the file-input pair", () => {
    // The catalog's media types and alternative-transport prose belong to the
    // MCP/describe surface; carrying them into the route tree would make the
    // generated CLI churn on wording changes.
    const entry = parseCapabilityCatalog([
      validEntry({
        transport: {
          type: "file-input",
          input: { field: "file", required: false, mediaTypes: ["text/csv"] },
          alternative: { type: "none", reason: "bytes are bytes" },
        },
      }),
    ])?.at(0);
    expect(entry?.transport).toEqual({
      type: "file-input",
      input: { field: "file", required: false },
    });
  });

  test("keeps an optional file-both transport distinct from a file-input one", () => {
    // Optionality is what makes a file-input capability invokable, so a
    // `file-both` whose input is optional is the shape most likely to be
    // mistaken for one: its RESPONSE still cannot cross the JSON transport.
    // The projection must carry the discriminant through unchanged.
    const entry = parseCapabilityCatalog([
      validEntry({
        transport: {
          type: "file-both",
          input: { field: "file", required: false, mediaTypes: ["text/csv"] },
          response: { mediaTypes: ["application/pdf"] },
          alternative: { type: "none", reason: "bytes are bytes" },
        },
      }),
    ])?.at(0);
    expect(entry?.transport).toEqual({
      type: "file-both",
      input: { field: "file", required: false },
    });
  });

  test("projects inputSchema sub-parts, keeping only the present ones", () => {
    const entry = parseCapabilityCatalog([
      validEntry({ inputSchema: { body: { type: "object" } } }),
    ])?.at(0);
    expect(entry?.inputSchema).toEqual({ body: { type: "object" } });
    expect("params" in (entry?.inputSchema ?? {})).toBe(false);
    expect("query" in (entry?.inputSchema ?? {})).toBe(false);
  });

  test("accepts an empty array as a valid (empty) catalog", () => {
    expect(parseCapabilityCatalog([])).toEqual([]);
  });

  test("preserves compound scope metadata", () => {
    expect(
      parseCapabilityCatalog([
        validEntry({ additionalScopes: ["stella:templates"] }),
      ])?.[0]?.additionalScopes,
    ).toEqual(["stella:templates"]);
  });
});

// The committed snapshot's ids are PUBLIC: they become CLI command paths and are
// passed verbatim to MCP's `invoke_capability`. The api-side exporter enforces
// the shape at derivation time; this asserts it on the artifact the CLI actually
// ships, so a hand-edited or stale snapshot cannot reintroduce an id whose final
// segment is an internal handler identifier (e.g. `deleteWorkspaceFooEntry`).
const CAPABILITY_ID_SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

describe("committed capability-catalog snapshot", () => {
  test("every id is dotted lowercase kebab-case", async () => {
    const catalogUrl = new URL("../capability-catalog.json", import.meta.url);
    const catalog: { id: string }[] = await Bun.file(catalogUrl).json();
    expect(catalog.length).toBeGreaterThan(0);

    const malformed = catalog
      .map(({ id }) => id)
      .filter((id) => {
        const segments = id.split(".");
        return (
          segments.length < 2 ||
          !segments.every((segment) =>
            CAPABILITY_ID_SEGMENT_PATTERN.test(segment),
          )
        );
      })
      .sort();
    expect(malformed).toEqual([]);
  });
});
