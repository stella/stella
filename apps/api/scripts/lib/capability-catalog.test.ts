import { describe, expect, test } from "bun:test";

import {
  checkTransportAgainstDerived,
  classifyVerbs,
  compareScopeStrictness,
  countCapabilityDispositions,
  deriveCapabilityId,
  deriveDomain,
  deriveHandlerImportPath,
  detectContextFidelityFeatures,
  finalIdSegment,
  findInlineCapabilityMismatches,
  findMalformedCapabilityIds,
  findStaleAccessOverrides,
  inputSchemaByteSize,
  isDestructiveName,
  isWellFormedCapabilityId,
  MAX_CAPABILITY_SCHEMA_BYTES,
  parseCapabilityTransport,
  resolveAccess,
  resolveHandlerKind,
  resolveScope,
  returnsInlineFileResponse,
  scanBinarySchemaFields,
  scanContextFidelity,
  scanFileResponseReturns,
  scanRouteHookGuards,
  schemaContainsBinaryFormat,
  serializeCatalog,
  serializeCoverageDoc,
  serializeDispatchModule,
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
        file: "apps/api/src/handlers/contacts/business-registries-lookup.ts",
        exportName: undefined,
      }),
    ).toBe("contacts.business-registries-lookup");
  });

  test("maps internal words onto the public vocabulary", () => {
    // The handler tree calls the client-engagement container a workspace; the
    // public id calls it a matter, domain segment and action verb alike.
    expect(
      deriveCapabilityId({
        file: "apps/api/src/handlers/workspaces/archive.ts",
        exportName: undefined,
      }),
    ).toBe("matters.archive");
    expect(
      deriveCapabilityId({
        file: "apps/api/src/handlers/workspaces/workspace-members-add.ts",
        exportName: undefined,
      }),
    ).toBe("matters.matter-members-add");
    expect(
      deriveCapabilityId({
        file: "apps/api/src/handlers/entities/copy-to-workspace.ts",
        exportName: undefined,
      }),
    ).toBe("entities.copy-to-matter");
  });

  test("throws for a path outside the handler tree", () => {
    expect(() =>
      deriveCapabilityId({
        file: "apps/api/src/lib/x.ts",
        exportName: undefined,
      }),
    ).toThrow("handler path is outside apps/api/src/handlers/");
  });
});

describe("isWellFormedCapabilityId", () => {
  test("accepts dotted lowercase kebab-case ids", () => {
    expect(isWellFormedCapabilityId("time-entries.create")).toBe(true);
    expect(isWellFormedCapabilityId("matters.anonymization-terms.delete")).toBe(
      true,
    );
    expect(isWellFormedCapabilityId("entities.read-summaries-count")).toBe(
      true,
    );
  });

  test("rejects a camelCase segment: the shape a named export's identifier produces", () => {
    expect(
      isWellFormedCapabilityId(
        "matters.anonymization-terms.deleteWorkspaceAnonymizationTerm",
      ),
    ).toBe(false);
    expect(
      isWellFormedCapabilityId(
        "entities.read-summaries.readEntitySummariesCount",
      ),
    ).toBe(false);
  });

  test("rejects underscores, empty segments, and single-segment ids", () => {
    expect(isWellFormedCapabilityId("time_entries.create")).toBe(false);
    expect(isWellFormedCapabilityId("time-entries..create")).toBe(false);
    expect(isWellFormedCapabilityId("time-entries.")).toBe(false);
    expect(isWellFormedCapabilityId("-leading.create")).toBe(false);
    expect(isWellFormedCapabilityId("trailing-.create")).toBe(false);
    expect(isWellFormedCapabilityId("create")).toBe(false);
  });

  test("every id derived from a default-export handler path is well-formed", () => {
    // The structural claim: a kebab-case-named file exported as its module
    // default cannot produce a malformed id, so the guard only ever fires on a
    // named export (or a non-kebab file/directory name).
    expect(
      isWellFormedCapabilityId(
        deriveCapabilityId({
          file: "apps/api/src/handlers/workspaces/anonymization-terms/delete.ts",
          exportName: undefined,
        }),
      ),
    ).toBe(true);
    expect(
      isWellFormedCapabilityId(
        deriveCapabilityId({
          file: "apps/api/src/handlers/workspaces/anonymization-terms/delete.ts",
          exportName: "deleteWorkspaceAnonymizationTerm",
        }),
      ),
    ).toBe(false);
  });
});

describe("findMalformedCapabilityIds", () => {
  test("returns only the malformed ids, sorted", () => {
    expect(
      findMalformedCapabilityIds([
        "time-entries.create",
        "entities.read-summaries.readEntitySummariesCount",
        "matters.anonymization-terms.delete",
        "billing_codes.create",
      ]),
    ).toEqual([
      "billing_codes.create",
      "entities.read-summaries.readEntitySummariesCount",
    ]);
  });

  test("is empty for an all-kebab catalog", () => {
    expect(findMalformedCapabilityIds(["a.b", "a.b-c", "a.b-c.d"])).toEqual([]);
  });
});

describe("deriveDomain", () => {
  test("is the first dot-separated segment", () => {
    expect(deriveDomain("time-entries.create")).toBe("time-entries");
    expect(deriveDomain("templates.fill-by-id")).toBe("templates");
  });

  test("handles a named-export id", () => {
    expect(deriveDomain("matters.read.named")).toBe("matters");
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
    expect(finalIdSegment("matters.read-active")).toBe("read-active");
    expect(finalIdSegment("a.b.c")).toBe("c");
  });
});

describe("resolveAccess", () => {
  const overrides = {
    "playbooks.run": { access: "write", destructive: false },
  } as const;

  test("derives from classifiable verbs when no override is pinned", () => {
    expect(
      resolveAccess({
        id: "entities.delete-by-id",
        verbs: ["delete"],
        hasPermissions: true,
        overrides: {},
      }),
    ).toEqual({ status: "resolved", access: "write", destructive: true });
  });

  test("an explicit override wins over classifiable verbs (read re-pin)", () => {
    expect(
      resolveAccess({
        id: "usage.get-entitlement",
        verbs: ["update"],
        hasPermissions: true,
        overrides: {
          "usage.get-entitlement": { access: "read", destructive: false },
        },
      }),
    ).toEqual({ status: "resolved", access: "read", destructive: false });
  });

  test("a re-pin cannot drop the destructive-name escalation", () => {
    expect(
      resolveAccess({
        id: "things.delete-by-id",
        verbs: ["update"],
        hasPermissions: true,
        overrides: {
          "things.delete-by-id": { access: "write", destructive: false },
        },
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
        id: "playbooks.run",
        verbs: ["apply"],
        hasPermissions: true,
        overrides: {
          "playbooks.run": { access: "read", destructive: false },
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

describe("isDestructiveName", () => {
  test("matches delete/remove-prefixed final segments, including camelCase named exports", () => {
    expect(isDestructiveName("document-types.delete-by-id")).toBe(true);
    expect(isDestructiveName("invoices.remove-entries")).toBe(true);
    expect(
      // A named-export id shape: no longer possible for a CATALOG id (see
      // isWellFormedCapabilityId), but the route-hook scan still derives ids
      // this way for named-export handlers, so the tokenizer must handle it.
      isDestructiveName("matters.legacy-terms.deleteWorkspaceLegacyTerm"),
    ).toBe(true);
  });

  test("matches delete/remove-suffixed final segments", () => {
    expect(isDestructiveName("matters.matter-members-remove")).toBe(true);
    expect(isDestructiveName("matters.matter-contacts-delete")).toBe(true);
    expect(isDestructiveName("tasks.entity-links-delete")).toBe(true);
    expect(isDestructiveName("tasks.assignees-remove")).toBe(true);
  });

  test("matches camelCase suffix forms", () => {
    expect(isDestructiveName("things.someNamedExportDelete")).toBe(true);
    expect(isDestructiveName("things.entityLinksRemove")).toBe(true);
  });

  test("does not match mid-name delete/remove tokens", () => {
    expect(isDestructiveName("things.bulk-delete-draft")).toBe(false);
    expect(isDestructiveName("things.bulkRemoveDraft")).toBe(false);
  });

  test("does not match soft operations or delete elsewhere in the id", () => {
    expect(isDestructiveName("matters.archive")).toBe(false);
    expect(isDestructiveName("entities.restore-version")).toBe(false);
    expect(isDestructiveName("entities.delete.read-status")).toBe(false);
  });
});

describe("resolveAccess destructive-name escalation", () => {
  test("escalates a suffix-named delete authorized via update", () => {
    expect(
      resolveAccess({
        id: "matters.matter-members-remove",
        verbs: ["update"],
        hasPermissions: true,
        overrides: {},
      }),
    ).toEqual({ status: "resolved", access: "write", destructive: true });
  });

  test("the opt-out still suppresses a first-token remove whose last token is not delete-like", () => {
    // `remove-entries` matches on its FIRST token under the tokenized rule,
    // so the reviewed opt-out is still required (and still consulted).
    expect(
      resolveAccess({
        id: "invoices.remove-entries",
        verbs: ["update"],
        hasPermissions: true,
        overrides: {},
        destructiveNameOptOuts: new Set(["invoices.remove-entries"]),
      }),
    ).toEqual({ status: "resolved", access: "write", destructive: false });
  });

  test("escalates an update-authorized delete to destructive", () => {
    expect(
      resolveAccess({
        id: "document-types.delete-by-id",
        verbs: ["update"],
        hasPermissions: true,
        overrides: {},
      }),
    ).toEqual({ status: "resolved", access: "write", destructive: true });
  });

  test("keeps a verb-derived destructive delete destructive", () => {
    expect(
      resolveAccess({
        id: "entities.delete",
        verbs: ["delete"],
        hasPermissions: true,
        overrides: {},
      }),
    ).toEqual({ status: "resolved", access: "write", destructive: true });
  });

  test("respects an explicit opt-out for a non-destructive unlink", () => {
    expect(
      resolveAccess({
        id: "invoices.remove-entries",
        verbs: ["update"],
        hasPermissions: true,
        overrides: {},
        destructiveNameOptOuts: new Set(["invoices.remove-entries"]),
      }),
    ).toEqual({ status: "resolved", access: "write", destructive: false });
  });

  test("also escalates an ACCESS_OVERRIDES-resolved entry", () => {
    expect(
      resolveAccess({
        id: "things.delete-draft",
        verbs: ["use"],
        hasPermissions: true,
        overrides: {
          "things.delete-draft": { access: "write", destructive: false },
        },
      }),
    ).toEqual({ status: "resolved", access: "write", destructive: true });
  });

  test("leaves non-delete names alone", () => {
    expect(
      resolveAccess({
        id: "entities.update",
        verbs: ["update"],
        hasPermissions: true,
        overrides: {},
      }),
    ).toEqual({ status: "resolved", access: "write", destructive: false });
  });
});

describe("countCapabilityDispositions", () => {
  test("counts capability dispositions, ignoring other types", () => {
    const source = `
      const a = { mcp: { type: "capability", reason: "billing_admin" } };
      const b = { mcp: { type: "internal", reason: "search_ui" } };
      const c = { mcp: { type: "capability", reason: "workflow_orchestration" } };
      const d = { mcp: { type: "tool", name: "search" } };
    `;
    expect(countCapabilityDispositions(source)).toBe(2);
  });

  test("is zero for a file without capability dispositions", () => {
    expect(
      countCapabilityDispositions('mcp: { type: "covered", by: "x" }'),
    ).toBe(0);
  });
});

describe("findInlineCapabilityMismatches", () => {
  const capability = (reason: string) =>
    `mcp: { type: "capability", reason: "${reason}" }`;

  test("flags an unpinned inline capability disposition", () => {
    const mismatches = findInlineCapabilityMismatches({
      files: [
        {
          id: "routes.ts",
          source: capability("billing_admin"),
          enumerableCapabilityCount: 0,
        },
      ],
      allowlist: {},
    });
    expect(mismatches).toEqual([
      { id: "routes.ts", inlineCount: 1, allowed: 0 },
    ]);
  });

  test("passes an endpoint module whose dispositions are all enumerable", () => {
    expect(
      findInlineCapabilityMismatches({
        files: [
          {
            id: "create.ts",
            source: capability("billing_admin"),
            enumerableCapabilityCount: 1,
          },
        ],
        allowlist: {},
      }),
    ).toEqual([]);
  });

  test("passes a pinned file at its exact count and flags one extra", () => {
    const two = `${capability("billing_admin")}\n${capability("billing_admin")}`;
    const three = `${two}\n${capability("billing_admin")}`;
    expect(
      findInlineCapabilityMismatches({
        files: [{ id: "routes.ts", source: two, enumerableCapabilityCount: 0 }],
        allowlist: { "routes.ts": 2 },
      }),
    ).toEqual([]);
    expect(
      findInlineCapabilityMismatches({
        files: [
          { id: "routes.ts", source: three, enumerableCapabilityCount: 0 },
        ],
        allowlist: { "routes.ts": 2 },
      }),
    ).toEqual([{ id: "routes.ts", inlineCount: 3, allowed: 2 }]);
  });

  test("flags a pinned file whose inline capabilities were refactored away", () => {
    // The count must shrink with the refactor, so the stale pin is visible.
    expect(
      findInlineCapabilityMismatches({
        files: [
          {
            id: "routes.ts",
            source: 'mcp: { type: "tool", name: "search" }',
            enumerableCapabilityCount: 0,
          },
        ],
        allowlist: { "routes.ts": 2 },
      }),
    ).toEqual([{ id: "routes.ts", inlineCount: 0, allowed: 2 }]);
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

describe("inputSchemaByteSize", () => {
  test("measures the compact serialization, not the pretty one", () => {
    expect(inputSchemaByteSize({ body: { type: "object" } })).toBe(
      '{"body":{"type":"object"}}'.length,
    );
  });

  test("measures UTF-8 bytes, not UTF-16 code units", () => {
    // 8 four-byte emoji: 16 code units but 32 UTF-8 bytes, plus JSON overhead.
    const inputSchema = { body: "\u{1F600}".repeat(8) };
    expect(JSON.stringify(inputSchema).length).toBeLessThanOrEqual(30);
    expect(inputSchemaByteSize(inputSchema)).toBeGreaterThan(30);
  });

  test("pins the committed cap", () => {
    expect(MAX_CAPABILITY_SCHEMA_BYTES).toBe(64 * 1024);
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
    const entries = [{ id: "x", inputSchema: { body: { type: "object" } } }];
    expect(JSON.parse(serializeCatalog(entries))).toEqual(entries);
  });
});

describe("compareScopeStrictness", () => {
  const tiers = {
    "stella:read": 1,
    "stella:matters_write": 2,
    "stella:documents_write": 2,
    "stella:admin_write": 3,
  };

  test("identical scopes are equal without consulting the table", () => {
    expect(
      compareScopeStrictness({
        first: "stella:unknown",
        second: "stella:unknown",
        tiers,
      }),
    ).toBe("equal");
  });

  test("orders scopes across tiers", () => {
    expect(
      compareScopeStrictness({
        first: "stella:admin_write",
        second: "stella:matters_write",
        tiers,
      }),
    ).toBe("first-stricter");
    expect(
      compareScopeStrictness({
        first: "stella:read",
        second: "stella:admin_write",
        tiers,
      }),
    ).toBe("second-stricter");
  });

  test("different scopes at the same tier are incomparable", () => {
    expect(
      compareScopeStrictness({
        first: "stella:matters_write",
        second: "stella:documents_write",
        tiers,
      }),
    ).toBe("incomparable");
  });

  test("a scope missing from the table is unknown (fail-closed)", () => {
    expect(
      compareScopeStrictness({
        first: "stella:matters_write",
        second: "stella:brand-new",
        tiers,
      }),
    ).toBe("unknown");
  });
});

describe("resolveScope", () => {
  const scopeTable = {
    entities: "stella:matters_write",
    "organization-settings": "stella:admin_write",
    legislation: "stella:read",
  };

  test("resolves a write-tiered domain to a read/write scope pair", () => {
    expect(
      resolveScope({
        domain: "entities",
        scopeTable,
        unmappedDomains: new Set(),
      }),
    ).toEqual({
      status: "resolved",
      readScope: "stella:read",
      writeScope: "stella:matters_write",
    });
  });

  test("downgrades an admin_write domain read to admin_read", () => {
    expect(
      resolveScope({
        domain: "organization-settings",
        scopeTable,
        unmappedDomains: new Set(),
      }),
    ).toEqual({
      status: "resolved",
      readScope: "stella:admin_read",
      writeScope: "stella:admin_write",
    });
  });

  test("a non-tiered domain reads and writes under the same scope", () => {
    expect(
      resolveScope({
        domain: "legislation",
        scopeTable,
        unmappedDomains: new Set(),
      }),
    ).toEqual({
      status: "resolved",
      readScope: "stella:read",
      writeScope: "stella:read",
    });
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

describe("deriveHandlerImportPath", () => {
  test("maps a handler file path to the @/api module alias", () => {
    expect(
      deriveHandlerImportPath("apps/api/src/handlers/time-entries/create.ts"),
    ).toBe("@/api/handlers/time-entries/create");
  });

  test("panics on a path outside apps/api/src", () => {
    expect(() => deriveHandlerImportPath("packages/cli/src/x.ts")).toThrow(
      "handler path is outside apps/api/src/",
    );
  });
});

describe("serializeDispatchModule", () => {
  test("emits an async lazy import thunk per record, named export threaded", () => {
    const out = serializeDispatchModule([
      {
        id: "time-entries.create",
        importPath: "@/api/handlers/time-entries/create",
        exportName: undefined,
      },
      {
        id: "views.export.read",
        importPath: "@/api/handlers/views/export",
        exportName: "readViewExport",
      },
    ]);
    expect(out).toContain(
      '"time-entries.create": { load: async () => await import("@/api/handlers/time-entries/create") },',
    );
    expect(out).toContain(
      '"views.export.read": { load: async () => await import("@/api/handlers/views/export"), exportName: "readViewExport" },',
    );
    expect(out).toContain("export const CAPABILITY_DISPATCH");
    expect(out.endsWith("\n")).toBe(true);
  });

  // Code-sanitization guard: every interpolated value must match its strict
  // pattern or the serializer throws, so a crafted handler path or export name
  // can never alter the generated module's code structure.
  test("rejects an id outside the strict pattern", () => {
    expect(() =>
      serializeDispatchModule([
        {
          id: 'evil"; process.exit(1); //',
          importPath: "@/api/handlers/x/y",
          exportName: undefined,
        },
      ]),
    ).toThrow(/unsafe id/u);
    expect(() =>
      serializeDispatchModule([
        { id: "a b", importPath: "@/api/handlers/x/y", exportName: undefined },
      ]),
    ).toThrow(/unsafe id/u);
    // Second layer of the id-shape guard: a camelCase segment (the shape a
    // named export's identifier produces) cannot reach the generated module
    // even if it somehow got past the exporter's own check.
    expect(() =>
      serializeDispatchModule([
        {
          id: "entities.read-summaries.readEntitySummariesCount",
          importPath: "@/api/handlers/entities/read-summaries",
          exportName: "readEntitySummariesCount",
        },
      ]),
    ).toThrow(/unsafe id/u);
  });

  test("rejects an import path outside the @/api alias or with unsafe characters", () => {
    expect(() =>
      serializeDispatchModule([
        {
          id: "x.y",
          importPath: '@/api/handlers/x") as never; //',
          exportName: undefined,
        },
      ]),
    ).toThrow(/unsafe import path/u);
    expect(() =>
      serializeDispatchModule([
        { id: "x.y", importPath: "node:child_process", exportName: undefined },
      ]),
    ).toThrow(/unsafe import path/u);
    expect(() =>
      serializeDispatchModule([
        {
          id: "x.y",
          importPath: "@/api/handlers/X/Upper",
          exportName: undefined,
        },
      ]),
    ).toThrow(/unsafe import path/u);
  });

  test("rejects an export name that is not a plain identifier", () => {
    expect(() =>
      serializeDispatchModule([
        {
          id: "x.y.z",
          importPath: "@/api/handlers/x/y",
          exportName: 'a"] ?? evil["b',
        },
      ]),
    ).toThrow(/unsafe export name/u);
    expect(() =>
      serializeDispatchModule([
        {
          id: "x.y.z",
          importPath: "@/api/handlers/x/y",
          exportName: "1startsWithDigit",
        },
      ]),
    ).toThrow(/unsafe export name/u);
  });
});

describe("serializeDispatchModule sanitization (rebuild from segments)", () => {
  test("rebuilds id, import path, and export name from validated segments", () => {
    // A valid record round-trips byte-identically: the rebuilt value equals the
    // input, so the sanitized flow does not change the committed artifact.
    const out = serializeDispatchModule([
      {
        id: "case-law.ingestion.status",
        importPath: "@/api/handlers/case-law/ingestion/status",
        exportName: undefined,
      },
    ]);
    expect(out).toContain(
      '"case-law.ingestion.status": { load: async () => await import("@/api/handlers/case-law/ingestion/status") },',
    );
  });

  test("rejects an id segment outside the allowlist", () => {
    expect(() =>
      serializeDispatchModule([
        {
          id: "x.y z",
          importPath: "@/api/handlers/x/y",
          exportName: undefined,
        },
      ]),
    ).toThrow(/unsafe id/u);
  });

  test("rejects an import-path segment outside the allowlist", () => {
    expect(() =>
      serializeDispatchModule([
        {
          id: "x.y",
          importPath: "@/api/handlers/x/UPPER",
          exportName: undefined,
        },
      ]),
    ).toThrow(/unsafe import path/u);
  });

  test("rejects dots-only import-path segments (path traversal shape)", () => {
    for (const importPath of [
      "@/api/handlers/../secrets",
      "@/api/handlers/./x",
      "@/api/handlers/.../x",
      "@/api/..",
      "@/api/handlers/.hidden",
      "@/api/handlers/trailing.",
    ]) {
      expect(
        () =>
          serializeDispatchModule([
            { id: "x.y", importPath, exportName: undefined },
          ]),
        importPath,
      ).toThrow(/unsafe import path/u);
    }
    // Interior dots stay legal (file extensions never appear, but versioned
    // names like `v1.2` would): only dot-anchored/dots-only segments fail.
    expect(() =>
      serializeDispatchModule([
        {
          id: "x.y",
          importPath: "@/api/handlers/x/v1.2",
          exportName: undefined,
        },
      ]),
    ).not.toThrow();
  });

  test("a dots-only id cannot slip through (split on dots leaves empty segments)", () => {
    expect(() =>
      serializeDispatchModule([
        { id: "..", importPath: "@/api/handlers/x/y", exportName: undefined },
      ]),
    ).toThrow(/unsafe id/u);
    expect(() =>
      serializeDispatchModule([
        { id: "a..b", importPath: "@/api/handlers/x/y", exportName: undefined },
      ]),
    ).toThrow(/unsafe id/u);
  });
});

describe("schemaContainsBinaryFormat", () => {
  test("detects a t.File-shaped field (format: binary) at any depth", () => {
    // Exactly how t.File({ maxSize }) serializes.
    const file = {
      default: "File",
      maxSize: "50m",
      type: "string",
      format: "binary",
    };
    expect(schemaContainsBinaryFormat(file)).toBe(true);
    expect(
      schemaContainsBinaryFormat({
        body: { type: "object", properties: { upload: file } },
      }),
    ).toBe(true);
  });

  test("detects t.Files (array items with format: binary)", () => {
    // Exactly how t.Files() serializes.
    expect(
      schemaContainsBinaryFormat({
        elysiaMeta: "Files",
        type: "array",
        items: { default: "Files", type: "string", format: "binary" },
      }),
    ).toBe(true);
  });

  test("detects binary inside union branches (anyOf)", () => {
    expect(
      schemaContainsBinaryFormat({
        anyOf: [{ type: "string" }, { type: "string", format: "binary" }],
      }),
    ).toBe(true);
  });

  test("is false for plain schemas and other string formats", () => {
    expect(
      schemaContainsBinaryFormat({
        type: "object",
        properties: {
          name: { type: "string" },
          when: { type: "string", format: "date-time" },
        },
      }),
    ).toBe(false);
    expect(schemaContainsBinaryFormat(undefined)).toBe(false);
    expect(schemaContainsBinaryFormat("binary")).toBe(false);
    // A field merely NAMED format is not a binary marker.
    expect(
      schemaContainsBinaryFormat({
        properties: { format: { type: "string" } },
      }),
    ).toBe(false);
  });
});

// The derived truth every declared `transport` is checked against. `t.File()`
// serializes as `{ type: "string", format: "binary" }`; `t.Optional(t.File())`
// differs only by absence from the part's `required` list, which is exactly the
// distinction between a suppressed capability and a fileless-exposed one.
const FILE_SCHEMA = {
  default: "File",
  maxSize: "50m",
  type: "string",
  format: "binary",
};

describe("scanBinarySchemaFields", () => {
  test("names a required file field with its part", () => {
    expect(
      scanBinarySchemaFields({
        body: {
          type: "object",
          required: ["file", "name"],
          properties: { file: FILE_SCHEMA, name: { type: "string" } },
        },
      }),
    ).toEqual({
      fields: [{ part: "body", field: "file", required: true }],
      unnameableParts: [],
    });
  });

  test("reports an optional file field as optional", () => {
    expect(
      scanBinarySchemaFields({
        body: { type: "object", properties: { file: FILE_SCHEMA } },
      }).fields,
    ).toEqual([{ part: "body", field: "file", required: false }]);
  });

  test("reports a part whose binary field is not a top-level property", () => {
    // A disposition names ONE field, so bytes nested inside an array item have
    // no truthful representation; the caller must fail rather than describe it.
    expect(
      scanBinarySchemaFields({
        body: {
          type: "object",
          properties: {
            attachments: { type: "array", items: { type: "object" } },
          },
          patternProperties: { "^x-": FILE_SCHEMA },
        },
      }),
    ).toEqual({ fields: [], unnameableParts: ["body"] });
  });

  test("reports a part whose binary field is nested inside an object property", () => {
    // `body.payload` CONTAINS a file but is not one, so naming it in a
    // disposition would give a caller a field they cannot put bytes in. The
    // ordinary nested shape has to be unnameable for the same reason the
    // array-item shape is.
    expect(
      scanBinarySchemaFields({
        body: {
          type: "object",
          properties: {
            payload: {
              type: "object",
              properties: { file: FILE_SCHEMA, note: { type: "string" } },
            },
          },
        },
      }),
    ).toEqual({ fields: [], unnameableParts: ["body"] });
  });

  test("names a file array, which a caller can still supply by that field", () => {
    expect(
      scanBinarySchemaFields({
        body: {
          type: "object",
          required: ["files"],
          properties: { files: { type: "array", items: FILE_SCHEMA } },
        },
      }),
    ).toEqual({
      fields: [{ part: "body", field: "files", required: true }],
      unnameableParts: [],
    });
  });

  test("is empty for a schema with no binary field", () => {
    expect(
      scanBinarySchemaFields({
        body: { type: "object", properties: { name: { type: "string" } } },
        query: { type: "object", properties: { limit: { type: "integer" } } },
      }),
    ).toEqual({ fields: [], unnameableParts: [] });
  });
});

describe("parseCapabilityTransport", () => {
  const alternative = { type: "none", reason: "bytes are bytes" };

  test("an absent declaration is the ordinary JSON transport", () => {
    expect(parseCapabilityTransport(undefined)).toEqual({
      status: "parsed",
      transport: { type: "json" },
    });
  });

  test("parses each file variant with its alternative", () => {
    expect(
      parseCapabilityTransport({
        type: "file-both",
        input: { field: "file", required: true, mediaTypes: ["text/csv"] },
        response: { mediaTypes: ["application/pdf"] },
        alternative,
      }),
    ).toEqual({
      status: "parsed",
      transport: {
        type: "file-both",
        input: { field: "file", required: true, mediaTypes: ["text/csv"] },
        response: { mediaTypes: ["application/pdf"] },
        alternative: { type: "none", reason: "bytes are bytes" },
      },
    });
  });

  test("rejects a file variant missing its leg, its alternative, or its prose", () => {
    // Each of these would otherwise ship a catalog entry that says less than it
    // claims to, which is the failure this field exists to prevent.
    expect(
      parseCapabilityTransport({ type: "file-input", alternative }).status,
    ).toBe("malformed");
    expect(
      parseCapabilityTransport({
        type: "file-input",
        input: { field: "file", required: true, mediaTypes: [] },
      }).status,
    ).toBe("malformed");
    expect(
      parseCapabilityTransport({
        type: "file-response",
        response: { mediaTypes: ["application/pdf"] },
        alternative: { type: "complete", via: ["x.y"] },
      }).status,
    ).toBe("malformed");
    expect(
      parseCapabilityTransport({
        type: "file-response",
        response: { mediaTypes: ["application/pdf"] },
        alternative: { type: "none", reason: "" },
      }).status,
    ).toBe("malformed");
    expect(parseCapabilityTransport({ type: "presigned" }).status).toBe(
      "malformed",
    );
  });
});

describe("checkTransportAgainstDerived", () => {
  const requiredFileScan = {
    fields: [{ part: "body" as const, field: "file", required: true }],
    unnameableParts: [],
  };
  const jsonTransport = { type: "json" as const };
  const alternative = { type: "none" as const, reason: "bytes are bytes" };
  const fileInput = (field: string, required: boolean) => ({
    type: "file-input" as const,
    input: { field, required, mediaTypes: [] },
    alternative,
  });

  test("accepts a declaration that matches the schema", () => {
    expect(
      checkTransportAgainstDerived({
        id: "x.upload",
        transport: fileInput("file", true),
        binaryScan: requiredFileScan,
      }),
    ).toEqual([]);
  });

  test("fails a file schema with no declaration, quoting the fix", () => {
    const [error] = checkTransportAgainstDerived({
      id: "x.upload",
      transport: jsonTransport,
      binaryScan: requiredFileScan,
    });
    expect(error).toContain("declares no file-input transport");
    expect(error).toContain('field: "file"');
    expect(error).toContain("required: true");
  });

  test("fails a declaration naming a field that is not binary", () => {
    expect(
      checkTransportAgainstDerived({
        id: "x.upload",
        transport: fileInput("attachment", true),
        binaryScan: requiredFileScan,
      }).join(" "),
    ).toContain('declares file-input field "attachment"');
  });

  test("fails a declaration whose required-ness has gone stale", () => {
    // The optionality flip is the decision point: an optional file means the
    // capability becomes reachable over JSON, so it must never happen silently.
    expect(
      checkTransportAgainstDerived({
        id: "x.prefill",
        transport: fileInput("file", true),
        binaryScan: {
          fields: [{ part: "body", field: "file", required: false }],
          unnameableParts: [],
        },
      }).join(" "),
    ).toContain(
      "declares its file input as required but the schema says optional",
    );
  });

  test("fails a file-input declaration on a schema with no binary field", () => {
    expect(
      checkTransportAgainstDerived({
        id: "x.create",
        transport: fileInput("file", true),
        binaryScan: { fields: [], unnameableParts: [] },
      }).join(" "),
    ).toContain("has no binary field");
  });

  test("fails a schema with more than one binary field", () => {
    expect(
      checkTransportAgainstDerived({
        id: "x.upload",
        transport: fileInput("file", true),
        binaryScan: {
          fields: [
            { part: "body", field: "file", required: true },
            { part: "body", field: "cover", required: true },
          ],
          unnameableParts: [],
        },
      }).join(" "),
    ).toContain("declares 2 binary fields");
  });

  test("fails a part whose binary field cannot be named", () => {
    expect(
      checkTransportAgainstDerived({
        id: "x.upload",
        transport: jsonTransport,
        binaryScan: { fields: [], unnameableParts: ["body"] },
      }).join(" "),
    ).toContain("nested below a top-level `body` property");
  });
});

describe("returnsInlineFileResponse", () => {
  test("detects an inline Result.ok(new Response(...)) success return", () => {
    expect(
      returnsInlineFileResponse("return Result.ok(new Response(body, {}));"),
    ).toBe(true);
    expect(
      returnsInlineFileResponse("return Result.ok(\n    new Response(zip));"),
    ).toBe(true);
  });

  test("detects inline binary success returns (Uint8Array, Blob)", () => {
    expect(
      returnsInlineFileResponse("return Result.ok(new Uint8Array(buffer));"),
    ).toBe(true);
    expect(
      returnsInlineFileResponse("return Result.ok(new Blob([bytes]));"),
    ).toBe(true);
  });

  test("detects the canonical secure document response constructor", () => {
    expect(
      returnsInlineFileResponse(
        "return Result.ok(secureDocumentResponse({ body }));",
      ),
    ).toBe(true);
    expect(
      returnsInlineFileResponse("return secureDocumentResponse({ body });"),
    ).toBe(true);
  });

  test("does not match a Response returned via an intermediate variable", () => {
    expect(returnsInlineFileResponse("return Result.ok(result);")).toBe(false);
  });

  test("does not match an error-only Response", () => {
    expect(
      returnsInlineFileResponse(
        "return new Response(JSON.stringify({ error }), { status: 400 });",
      ),
    ).toBe(false);
  });
});

describe("scanFileResponseReturns", () => {
  test("flags an unflagged inline file-response handler", () => {
    const scan = scanFileResponseReturns({
      entries: [
        { id: "a.export", source: "return Result.ok(new Response(csv));" },
        { id: "b.read", source: "return Result.ok({ ok: true });" },
      ],
      flaggedIds: new Set(),
    });
    expect(scan.violations).toEqual(["a.export"]);
    expect(scan.staleFlags).toEqual([]);
  });

  test("a flagged inline handler is not a violation", () => {
    const scan = scanFileResponseReturns({
      entries: [
        { id: "a.export", source: "return Result.ok(new Response(x));" },
      ],
      flaggedIds: new Set(["a.export"]),
    });
    expect(scan.violations).toEqual([]);
    expect(scan.staleFlags).toEqual([]);
  });

  test("keeps a flagged secure constructor response non-stale", () => {
    const scan = scanFileResponseReturns({
      entries: [
        {
          id: "templates.manifest",
          source: "return secureDocumentResponse({ body });",
        },
      ],
      flaggedIds: new Set(["templates.manifest"]),
    });
    expect(scan.violations).toEqual([]);
    expect(scan.staleFlags).toEqual([]);
  });

  test("keeps a flagged variable-returned Response honest via the stale signal", () => {
    // A legacy helper can return an intermediate Response that the inline
    // detector misses; constructing that Response still keeps the flag honest.
    const scan = scanFileResponseReturns({
      entries: [
        {
          id: "legacy.export",
          source: "const r = new Response(pdf);\nreturn Result.ok(result);",
        },
      ],
      flaggedIds: new Set(["legacy.export"]),
    });
    expect(scan.violations).toEqual([]);
    expect(scan.staleFlags).toEqual([]);
  });

  test("keeps a flagged helper-built binary payload honest via the stale signal", () => {
    // time-entries.export-pdf-shaped: the bytes come back from a helper typed
    // Uint8Array, invisible to the inline detector, but the Uint8Array mention
    // keeps the flag non-stale.
    const scan = scanFileResponseReturns({
      entries: [
        {
          id: "time-entries.export-pdf",
          source:
            "const buildMinimalPdf = (lines: readonly string[]): Uint8Array => enc.encode(pdf);\nreturn Result.ok(response);",
        },
      ],
      flaggedIds: new Set(["time-entries.export-pdf"]),
    });
    expect(scan.violations).toEqual([]);
    expect(scan.staleFlags).toEqual([]);
  });

  test("flags a stale entry whose handler no longer constructs a Response", () => {
    const scan = scanFileResponseReturns({
      entries: [{ id: "a.export", source: "return Result.ok({ url });" }],
      flaggedIds: new Set(["a.export"]),
    });
    expect(scan.violations).toEqual([]);
    expect(scan.staleFlags).toEqual(["a.export"]);
  });

  test("flags a flagged id that is no longer a catalog entry", () => {
    const scan = scanFileResponseReturns({
      entries: [],
      flaggedIds: new Set(["gone.export"]),
    });
    expect(scan.staleFlags).toEqual(["gone.export"]);
  });
});

describe("scanRouteHookGuards", () => {
  const hookedRoute = `
import getStatus from "@/api/handlers/case-law/ingestion/status";
import listLinks from "@/api/handlers/case-law/matter-links/list";
const adminRoute = new Elysia({ prefix: "/case/admin" })
  .use(authMacro)
  .onBeforeHandle(({ memberRole, set }) => {
    if (!ADMIN_BYPASS_ROLES.includes(memberRole.role)) {
      set.status = 403;
      return { error: "Forbidden" };
    }
    return undefined;
  })
  .get("/ingestion/status", getStatus.handler, {});
const openRoute = new Elysia({ prefix: "/case" })
  .get("/links", listLinks.handler, {});
`;

  test("flags a capability mounted under a route hook when unwaived", () => {
    const scan = scanRouteHookGuards({
      routeFiles: [{ id: "case-law/routes.ts", source: hookedRoute }],
      capabilityIds: new Set([
        "case-law.ingestion.status",
        "case-law.matter-links.list",
      ]),
      waivedIds: new Set(),
    });
    expect(scan.violations).toEqual([
      { routeFile: "case-law/routes.ts", id: "case-law.ingestion.status" },
    ]);
    expect(scan.staleWaivers).toEqual([]);
  });

  test("a waived hook-guarded capability is not a violation", () => {
    const scan = scanRouteHookGuards({
      routeFiles: [{ id: "case-law/routes.ts", source: hookedRoute }],
      capabilityIds: new Set(["case-law.ingestion.status"]),
      waivedIds: new Set(["case-law.ingestion.status"]),
    });
    expect(scan.violations).toEqual([]);
    expect(scan.staleWaivers).toEqual([]);
  });

  test("a handler mounted only under a non-hooked instance is not flagged", () => {
    const scan = scanRouteHookGuards({
      routeFiles: [{ id: "case-law/routes.ts", source: hookedRoute }],
      capabilityIds: new Set(["case-law.matter-links.list"]),
      waivedIds: new Set(),
    });
    expect(scan.violations).toEqual([]);
  });

  test("resolves a named-export handler mount to its capability id", () => {
    const source = `
import { readLegacySummariesCount } from "@/api/handlers/entities/legacy-summaries";
const r = new Elysia()
  .beforeHandle(() => undefined)
  .get("/count", readLegacySummariesCount.handler, {});
`;
    const scan = scanRouteHookGuards({
      routeFiles: [{ id: "entities/routes.ts", source }],
      capabilityIds: new Set([
        "entities.legacy-summaries.readLegacySummariesCount",
      ]),
      waivedIds: new Set(),
    });
    expect(scan.violations).toEqual([
      {
        routeFile: "entities/routes.ts",
        id: "entities.legacy-summaries.readLegacySummariesCount",
      },
    ]);
  });

  test("reports a stale waiver no longer mounted under any hook", () => {
    const scan = scanRouteHookGuards({
      routeFiles: [{ id: "case-law/routes.ts", source: hookedRoute }],
      capabilityIds: new Set(["case-law.ingestion.status"]),
      waivedIds: new Set(["case-law.ingestion.status", "gone.capability"]),
    });
    expect(scan.staleWaivers).toEqual(["gone.capability"]);
  });
});

describe("serializeCoverageDoc", () => {
  const JSON_TRANSPORT = { type: "json" as const };
  const entries = [
    {
      id: "time-entries.create",
      access: "write" as const,
      destructive: false,
      scope: "stella:billing_write",
      feature: "FEATURE_TIME_BILLING",
      transport: JSON_TRANSPORT,
      mcp: { type: "tool" as const, name: "save_time_entry" },
    },
    {
      id: "time-entries.delete",
      access: "write" as const,
      destructive: true,
      scope: "stella:billing_write",
      feature: "FEATURE_TIME_BILLING",
      transport: JSON_TRANSPORT,
      mcp: { type: "covered" as const, by: "save_time_entry" },
    },
    {
      id: "time-entries.export-pdf",
      access: "read" as const,
      destructive: false,
      scope: "stella:billing_write",
      feature: "FEATURE_TIME_BILLING",
      transport: {
        type: "file-response" as const,
        response: { mediaTypes: ["application/pdf"] },
        alternative: {
          type: "partial" as const,
          via: ["time-entries.export-csv"],
          limitation: "the rendered PDF is not produced",
        },
      },
      mcp: { type: "capability" as const, reason: "billing_admin" },
    },
    {
      id: "entities.read-summaries-count",
      access: "read" as const,
      destructive: false,
      scope: "stella:matters_write",
      transport: JSON_TRANSPORT,
      mcp: { type: "capability" as const, reason: "workflow_orchestration" },
    },
    {
      id: "templates.prefill",
      access: "write" as const,
      destructive: false,
      scope: "stella:templates",
      transport: {
        type: "file-input" as const,
        input: { field: "file", required: false, mediaTypes: [] },
        alternative: {
          type: "none" as const,
          reason: "the bytes have no JSON form",
        },
      },
      mcp: { type: "capability" as const, reason: "template_authoring_ui" },
    },
    {
      id: "templates.fill-to-matter",
      access: "write" as const,
      destructive: false,
      scope: "stella:documents_write",
      additionalScopes: ["stella:templates"],
      transport: JSON_TRANSPORT,
      mcp: { type: "covered" as const, by: "save_filled_template" },
    },
  ];

  const internalWaiverCounts = {
    search_ui: 3,
    auth_plumbing: 1,
  };

  // The REAL generated command path per capability id, as buildCliRouteTree
  // would produce it. `entities.read-summaries-count` is deliberately given a
  // collision-fallback path (relocated under `capability …`) to prove the doc
  // renders the map's path, never an id-derived guess.
  const cliCommandPathById = new Map<string, readonly string[]>([
    [
      "entities.read-summaries-count",
      ["capability", "entities", "read-summaries-count"],
    ],
    ["templates.prefill", ["capability", "templates", "prefill"]],
  ]);

  const render = (input?: {
    entries?: typeof entries;
    internalWaiverCounts?: Record<string, number>;
  }): string =>
    serializeCoverageDoc({
      entries: input?.entries ?? entries,
      cliCommandPathById,
      internalWaiverCounts: input?.internalWaiverCounts ?? internalWaiverCounts,
    });

  test("renders one alphabetically sorted section per domain with id-sorted rows", () => {
    const doc = render();
    const entitiesIndex = doc.indexOf("## entities");
    const timeEntriesIndex = doc.indexOf("## time-entries");
    expect(entitiesIndex).toBeGreaterThan(-1);
    expect(timeEntriesIndex).toBeGreaterThan(-1);
    expect(entitiesIndex).toBeLessThan(timeEntriesIndex);

    const createIndex = doc.indexOf("`time-entries.create`");
    const deleteIndex = doc.indexOf("`time-entries.delete`");
    const exportIndex = doc.indexOf("`time-entries.export-pdf`");
    expect(createIndex).toBeLessThan(deleteIndex);
    expect(deleteIndex).toBeLessThan(exportIndex);
  });

  test("renders access as read/write/write,destructive and defaults feature to an em dash", () => {
    const doc = render();
    expect(doc).toContain(
      "| `time-entries.create` | write | stella:billing_write | FEATURE_TIME_BILLING | curated tool `save_time_entry` |",
    );
    expect(doc).toContain(
      "| `time-entries.delete` | write, destructive | stella:billing_write | FEATURE_TIME_BILLING | covered by `save_time_entry` |",
    );
    expect(doc).toContain(
      "| `templates.fill-to-matter` | write | stella:documents_write, stella:templates | — | covered by `save_filled_template` |",
    );
  });

  test("renders the generated (collision-aware) command path, not an id-derived one", () => {
    const doc = render();
    expect(doc).toContain(
      "| `entities.read-summaries-count` | read | stella:matters_write | — | generic invoke → `stella capability entities read-summaries-count` |",
    );
    // The naive id-derived path must not appear anywhere.
    expect(doc).not.toContain("`stella entities read-summaries-count`");
  });

  test("panics when a non-file capability entry has no generated command path", () => {
    expect(() =>
      serializeCoverageDoc({
        entries,
        cliCommandPathById: new Map(),
        internalWaiverCounts,
      }),
    ).toThrow(/no generated CLI command path/u);
  });

  test("a suppressed file capability states why it is excluded and names the alternative", () => {
    const doc = render();
    expect(doc).toContain(
      "| `time-entries.export-pdf` | read | stella:billing_write | FEATURE_TIME_BILLING | not runnable over the generic transport: returns bytes, which the generic transport cannot serialize. time-entries.export-csv covers part of this: the rendered PDF is not produced |",
    );
  });

  test("a fileless-mode capability renders its command plus the field it cannot take", () => {
    // The optional-file case: exposed, with the limitation stated rather than
    // left for the caller to discover from a server refusal.
    const doc = render();
    expect(doc).toContain(
      "| `templates.prefill` | write | stella:templates | — | generic invoke → `stella capability templates prefill` (JSON mode only: `file` cannot be supplied) |",
    );
  });

  test("renders the waived-internal-handlers section sorted by reason with a total", () => {
    const doc = render();
    const section = doc.slice(doc.indexOf("## Waived internal handlers"));
    const authIndex = section.indexOf("| auth_plumbing | 1 |");
    const searchIndex = section.indexOf("| search_ui | 3 |");
    expect(authIndex).toBeGreaterThan(-1);
    expect(searchIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeLessThan(searchIndex);
    expect(section).toContain("Total: 4");
  });

  test("is stable across calls given the same input (deterministic, single trailing newline)", () => {
    const first = render();
    const second = render({ entries: [...entries].toReversed() });
    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
    expect(first.endsWith("\n\n")).toBe(false);
  });

  test("empty inputs still render a generated-file header and an empty waiver total", () => {
    const doc = render({ entries: [], internalWaiverCounts: {} });
    expect(doc).toContain(
      "GENERATED by apps/api/scripts/export-capability-catalog.ts",
    );
    expect(doc).toContain("## Waived internal handlers");
    expect(doc).toContain("Total: 0");
  });
});

describe("context-fidelity scan", () => {
  test("detects destructured set/redirect/cookie usage", () => {
    expect(
      detectContextFidelityFeatures("const { set } = ctx; set.status = 201;"),
    ).toEqual(["set.status"]);
    expect(detectContextFidelityFeatures("return redirect('/x');")).toEqual([
      "redirect()",
    ]);
    expect(detectContextFidelityFeatures("const rows = new Set();")).toEqual(
      [],
    );
  });

  test("flags a tripped-but-unwaived capability and stale waivers", () => {
    const scan = scanContextFidelity({
      entries: [
        { id: "a.set", source: "set.headers['x'] = '1';" },
        { id: "b.clean", source: "return Result.ok({});" },
      ],
      waivedIds: new Set(["b.clean"]),
    });
    expect(scan.violations).toEqual([
      { id: "a.set", features: ["set.headers"] },
    ]);
    expect(scan.staleWaivers).toEqual(["b.clean"]);
  });

  test("a waived tripped capability is not a violation", () => {
    const scan = scanContextFidelity({
      entries: [{ id: "a.set", source: "set.status = 200;" }],
      waivedIds: new Set(["a.set"]),
    });
    expect(scan.violations).toEqual([]);
    expect(scan.staleWaivers).toEqual([]);
  });
});
