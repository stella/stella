import { describe, expect, test } from "bun:test";

import {
  capInputSchema,
  classifyVerbs,
  deriveCapabilityId,
  deriveDomain,
  finalIdSegment,
  findStaleAccessOverrides,
  MAX_CAPABILITY_SCHEMA_BYTES,
  resolveAccess,
  resolveHandlerKind,
  resolveScope,
  serializeCatalog,
} from "./capability-catalog";

describe("deriveCapabilityId", () => {
  test("joins the handler-relative path with dots for a default export", () => {
    expect(
      deriveCapabilityId({
        file: "apps/api/src/handlers/time-entries/create.ts",
        exportName: undefined,
      }),
    ).toBe("time-entries.create");
  });

  test("suffixes the export name for a named export", () => {
    expect(
      deriveCapabilityId({
        file: "apps/api/src/handlers/time-entries/create.ts",
        exportName: "extra",
      }),
    ).toBe("time-entries.create.extra");
  });

  test("preserves hyphens in directory and file names", () => {
    expect(
      deriveCapabilityId({
        file: "apps/api/src/handlers/contacts/read-by-id.ts",
        exportName: undefined,
      }),
    ).toBe("contacts.read-by-id");
  });

  test("throws for a path outside the handler tree", () => {
    expect(() =>
      deriveCapabilityId({
        file: "apps/api/src/lib/x.ts",
        exportName: undefined,
      }),
    ).toThrow();
  });
});

describe("deriveDomain", () => {
  test("is the first dot-separated segment", () => {
    expect(deriveDomain("time-entries.create")).toBe("time-entries");
    expect(deriveDomain("templates.fill-by-id")).toBe("templates");
  });

  test("handles a named-export id", () => {
    expect(deriveDomain("workspaces.read.named")).toBe("workspaces");
  });
});

describe("classifyVerbs", () => {
  test("read verbs classify as read, non-destructive", () => {
    expect(classifyVerbs(["read"])).toEqual({
      ok: true,
      value: { access: "read", destructive: false },
    });
  });

  test("any write verb makes it a write", () => {
    expect(classifyVerbs(["read", "create"])).toEqual({
      ok: true,
      value: { access: "write", destructive: false },
    });
  });

  test("delete marks it destructive", () => {
    expect(classifyVerbs(["create", "update", "delete"])).toEqual({
      ok: true,
      value: { access: "write", destructive: true },
    });
  });

  test("an unknown verb fails with the offending verbs (deduped, sorted)", () => {
    expect(classifyVerbs(["use", "apply", "use"])).toEqual({
      ok: false,
      unknownVerbs: ["apply", "use"],
    });
  });
});

describe("finalIdSegment", () => {
  test("is the last dot-separated segment", () => {
    expect(finalIdSegment("workspaces.read-active")).toBe("read-active");
    expect(finalIdSegment("a.b.c")).toBe("c");
  });
});

describe("resolveAccess", () => {
  const overrides = {
    "playbooks.run": { access: "write", destructive: false },
  } as const;

  test("derives from classifiable verbs and ignores the override", () => {
    expect(
      resolveAccess({
        id: "entities.delete-by-id",
        verbs: ["delete"],
        hasPermissions: true,
        overrides: {},
      }),
    ).toEqual({ status: "resolved", access: "write", destructive: true });
  });

  test("requires an override for an unclassifiable verb", () => {
    const result = resolveAccess({
      id: "templates.fill",
      verbs: ["use"],
      hasPermissions: true,
      overrides: {},
    });
    expect(result.status).toBe("needs-override");
  });

  test("the playbook approve/apply verbs are unclassifiable without an override", () => {
    expect(
      resolveAccess({
        id: "playbooks.approve",
        verbs: ["approve"],
        hasPermissions: true,
        overrides: {},
      }).status,
    ).toBe("needs-override");
    expect(
      resolveAccess({
        id: "playbooks.review",
        verbs: ["apply"],
        hasPermissions: true,
        overrides: {
          "playbooks.review": { access: "read", destructive: false },
        },
      }),
    ).toEqual({ status: "resolved", access: "read", destructive: false });
  });

  test("uses the override when verbs are unclassifiable", () => {
    expect(
      resolveAccess({
        id: "playbooks.run",
        verbs: ["apply"],
        hasPermissions: true,
        overrides,
      }),
    ).toEqual({ status: "resolved", access: "write", destructive: false });
  });

  test("permissionless get-like names default to read", () => {
    expect(
      resolveAccess({
        id: "public.read-thing",
        verbs: [],
        hasPermissions: false,
        overrides: {},
      }),
    ).toEqual({ status: "resolved", access: "read", destructive: false });
  });

  test("permissionless non-get names require an override", () => {
    expect(
      resolveAccess({
        id: "public.sync-thing",
        verbs: [],
        hasPermissions: false,
        overrides: {},
      }).status,
    ).toBe("needs-override");
  });

  test("permissionless override wins over the name heuristic", () => {
    expect(
      resolveAccess({
        id: "public.sync-thing",
        verbs: [],
        hasPermissions: false,
        overrides: {
          "public.sync-thing": { access: "write", destructive: true },
        },
      }),
    ).toEqual({ status: "resolved", access: "write", destructive: true });
  });
});

describe("findStaleAccessOverrides", () => {
  test("flags an override id that was never consulted", () => {
    expect(
      findStaleAccessOverrides({
        overrides: {
          "playbooks.run": { access: "write", destructive: false },
          "gone.capability": { access: "read", destructive: false },
        },
        usedIds: ["playbooks.run"],
      }),
    ).toEqual(["gone.capability"]);
  });

  test("passes when every override was consulted", () => {
    expect(
      findStaleAccessOverrides({
        overrides: { "playbooks.run": { access: "write", destructive: false } },
        usedIds: ["playbooks.run"],
      }),
    ).toEqual([]);
  });
});

describe("resolveHandlerKind", () => {
  test("attributes a file's single factory kind", () => {
    expect(
      resolveHandlerKind({
        id: "time-entries.create",
        kinds: ["workspace"],
        overrides: {},
      }),
    ).toEqual({ status: "resolved", kind: "workspace" });
  });

  test("requires an override when a file mixes factory kinds", () => {
    const result = resolveHandlerKind({
      id: "mixed.endpoint",
      kinds: ["workspace", "public"],
      overrides: {},
    });
    expect(result.status).toBe("needs-override");
  });

  test("uses the override for a mixed-kind file", () => {
    expect(
      resolveHandlerKind({
        id: "mixed.endpoint",
        kinds: ["workspace", "public"],
        overrides: { "mixed.endpoint": "public" },
      }),
    ).toEqual({ status: "resolved", kind: "public" });
  });

  test("fails when no factory kind was detected", () => {
    expect(
      resolveHandlerKind({ id: "empty.file", kinds: [], overrides: {} }).status,
    ).toBe("needs-override");
  });
});

describe("capInputSchema", () => {
  test("passes a schema under the cap through unchanged", () => {
    const inputSchema = { body: { type: "object" } };
    expect(capInputSchema(inputSchema)).toEqual({
      truncated: false,
      inputSchema,
    });
  });

  test("truncates a schema whose compact serialization exceeds the cap", () => {
    const inputSchema = { body: { blob: "x".repeat(32) } };
    expect(capInputSchema(inputSchema, 16)).toEqual({ truncated: true });
  });

  test("measures UTF-8 bytes, not UTF-16 code units", () => {
    // 8 four-byte emoji: 16 code units but 32 UTF-8 bytes, plus JSON overhead.
    const inputSchema = { body: "😀".repeat(8) };
    expect(JSON.stringify(inputSchema).length).toBeLessThanOrEqual(30);
    expect(capInputSchema(inputSchema, 30)).toEqual({ truncated: true });
  });

  test("defaults to the committed 64KiB cap", () => {
    expect(MAX_CAPABILITY_SCHEMA_BYTES).toBe(64 * 1024);
    const under = { body: "x".repeat(MAX_CAPABILITY_SCHEMA_BYTES - 20) };
    expect(capInputSchema(under).truncated).toBe(false);
    const over = { body: "x".repeat(MAX_CAPABILITY_SCHEMA_BYTES + 1) };
    expect(capInputSchema(over).truncated).toBe(true);
  });
});

describe("serializeCatalog", () => {
  test("emits compact single-line JSON with a trailing newline", () => {
    const serialized = serializeCatalog([
      { id: "a.b", access: "read" },
      { id: "c.d", access: "write" },
    ]);
    expect(serialized.endsWith("\n")).toBe(true);
    const body = serialized.slice(0, -1);
    expect(body.includes("\n")).toBe(false);
    expect(body).toBe(
      '[{"id":"a.b","access":"read"},{"id":"c.d","access":"write"}]',
    );
  });

  test("round-trips through JSON.parse", () => {
    const entries = [{ id: "x", inputSchemaTruncated: true }];
    expect(JSON.parse(serializeCatalog(entries))).toEqual(entries);
  });
});

describe("resolveScope", () => {
  const scopeTable = { entities: "stella:matters_write" };

  test("resolves a mapped domain", () => {
    expect(
      resolveScope({
        domain: "entities",
        scopeTable,
        unmappedDomains: new Set(),
      }),
    ).toEqual({ status: "resolved", scope: "stella:matters_write" });
  });

  test("acknowledges an explicitly-unmapped domain", () => {
    expect(
      resolveScope({
        domain: "mystery",
        scopeTable,
        unmappedDomains: new Set(["mystery"]),
      }),
    ).toEqual({ status: "acknowledged-unmapped" });
  });

  test("fails an unknown domain", () => {
    expect(
      resolveScope({
        domain: "mystery",
        scopeTable,
        unmappedDomains: new Set(),
      }),
    ).toEqual({ status: "unmapped" });
  });
});
