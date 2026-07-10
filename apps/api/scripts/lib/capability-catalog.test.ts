import { describe, expect, test } from "bun:test";

import {
  capInputSchema,
  classifyVerbs,
  compareScopeStrictness,
  countCapabilityDispositions,
  deriveCapabilityId,
  deriveDomain,
  deriveHandlerImportPath,
  detectContextFidelityFeatures,
  finalIdSegment,
  findInlineCapabilityMismatches,
  findStaleAccessOverrides,
  isDestructiveName,
  MAX_CAPABILITY_SCHEMA_BYTES,
  resolveAccess,
  resolveHandlerKind,
  resolveScope,
  returnsInlineFileResponse,
  scanContextFidelity,
  scanFileResponseReturns,
  scanRouteHookGuards,
  serializeDispatchModule,
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

describe("isDestructiveName", () => {
  test("matches delete/remove-prefixed final segments, including camelCase named exports", () => {
    expect(isDestructiveName("document-types.delete-by-id")).toBe(true);
    expect(isDestructiveName("invoices.remove-entries")).toBe(true);
    expect(
      isDestructiveName(
        "workspaces.anonymization-terms.deleteWorkspaceAnonymizationTerm",
      ),
    ).toBe(true);
  });

  test("matches delete/remove-suffixed final segments", () => {
    expect(isDestructiveName("workspaces.workspace-members-remove")).toBe(true);
    expect(isDestructiveName("workspaces.workspace-contacts-delete")).toBe(
      true,
    );
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
    expect(isDestructiveName("workspaces.archive")).toBe(false);
    expect(isDestructiveName("entities.restore-version")).toBe(false);
    expect(isDestructiveName("entities.delete.read-status")).toBe(false);
  });
});

describe("resolveAccess destructive-name escalation", () => {
  test("escalates a suffix-named delete authorized via update", () => {
    expect(
      resolveAccess({
        id: "workspaces.workspace-members-remove",
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

describe("deriveHandlerImportPath", () => {
  test("maps a handler file path to the @/api module alias", () => {
    expect(
      deriveHandlerImportPath("apps/api/src/handlers/time-entries/create.ts"),
    ).toBe("@/api/handlers/time-entries/create");
  });

  test("panics on a path outside apps/api/src", () => {
    expect(() => deriveHandlerImportPath("packages/cli/src/x.ts")).toThrow();
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
        id: "views.export.readViewExport",
        importPath: "@/api/handlers/views/export",
        exportName: "readViewExport",
      },
    ]);
    expect(out).toContain(
      '"time-entries.create": { load: async () => await import("@/api/handlers/time-entries/create") },',
    );
    expect(out).toContain(
      '"views.export.readViewExport": { load: async () => await import("@/api/handlers/views/export"), exportName: "readViewExport" },',
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

  test("keeps a flagged variable-returned Response honest via constructsResponse", () => {
    // templates.fill-shaped: returns a Response via a helper, so the inline
    // detector misses it, but it still constructs a Response, so not stale.
    const scan = scanFileResponseReturns({
      entries: [
        {
          id: "templates.fill",
          source: "const r = new Response(pdf);\nreturn Result.ok(result);",
        },
      ],
      flaggedIds: new Set(["templates.fill"]),
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
import { readEntitySummariesCount } from "@/api/handlers/entities/read-summaries";
const r = new Elysia()
  .beforeHandle(() => undefined)
  .get("/count", readEntitySummariesCount.handler, {});
`;
    const scan = scanRouteHookGuards({
      routeFiles: [{ id: "entities/routes.ts", source }],
      capabilityIds: new Set([
        "entities.read-summaries.readEntitySummariesCount",
      ]),
      waivedIds: new Set(),
    });
    expect(scan.violations).toEqual([
      {
        routeFile: "entities/routes.ts",
        id: "entities.read-summaries.readEntitySummariesCount",
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
