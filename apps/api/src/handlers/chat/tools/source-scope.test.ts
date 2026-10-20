import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import { describe, expect, it } from "bun:test";
import * as v from "valibot";

import type { ChatSourceScope } from "@stll/api-contract";

import { buildExternalMcpSystemHint } from "@/api/handlers/chat/tools/external-mcp-tools";
import type { LoadedExternalMcpConnector } from "@/api/handlers/chat/tools/external-mcp-tools";
import {
  businessRegistryCallScope,
  restrictChatToolsToSourceScope,
  scopeBusinessRegistryLookup,
  scopedExternalConnectors,
  scopedRegistries,
  sourceScopeDroppedTools,
} from "@/api/handlers/chat/tools/source-scope";
import type { ScopedRegistry } from "@/api/handlers/chat/tools/source-scope";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";

const ARES: ScopedRegistry = { slug: "ares", country: "CZ" };
const ORSR: ScopedRegistry = { slug: "orsr", country: "SK" };
const RPO: ScopedRegistry = { slug: "rpo", country: "SK" };
const BRREG: ScopedRegistry = { slug: "brreg", country: "NO" };
const ENABLED = [ARES, ORSR, RPO, BRREG];

const LEGAL_SEARCH: LoadedExternalMcpConnector = {
  connectorId: toSafeId<"mcpConnector">("11111111-1111-4111-8111-111111111111"),
  slug: "legal-search",
  displayName: "Legal Search",
  description: "Searches foreign case law.",
  toolNames: ["find", "lookup_any"],
  // Deliberately not named after the slug: tools map by the connector's list.
  exposedToolNames: ["mcp__legal-search__find", "lookup_any"],
};
const NOTES: LoadedExternalMcpConnector = {
  connectorId: toSafeId<"mcpConnector">("22222222-2222-4222-8222-222222222222"),
  slug: "notes",
  displayName: "Notes",
  description: "The user's notes.",
  toolNames: ["read"],
  exposedToolNames: ["mcp__notes__read"],
};
const CONNECTORS = [LEGAL_SEARCH, NOTES];

const toolMap = (names: readonly string[]): ChatToolMap =>
  Object.fromEntries(
    names.map((name) => [
      name,
      toolDefinition({
        name,
        description: "test tool",
        inputSchema: toTanStackToolSchema(v.object({ query: v.string() })),
      }),
    ]),
  );

const EXTERNAL_TOOL_NAMES = [
  ...LEGAL_SEARCH.exposedToolNames,
  ...NOTES.exposedToolNames,
];
const TOOLS = toolMap([
  "execute_typescript",
  "list_matters_direct",
  "business_registry_lookup",
  "counterparty_check",
  "boe_search_legislation",
  "infosoud_lookup_case",
  ...EXTERNAL_TOOL_NAMES,
]);

const restrict = (scopes: readonly ChatSourceScope[]): string[] =>
  Object.keys(
    restrictChatToolsToSourceScope(TOOLS, {
      scopes,
      externalToolNames: EXTERNAL_TOOL_NAMES,
      connectors: CONNECTORS,
      registries: scopedRegistries({ scopes, enabled: ENABLED }),
    }),
  );

/** The refusal's code and hint, failing the test when the call went through. */
const refusal = (
  result: ReturnType<typeof scopeBusinessRegistryLookup>,
): { message: string; code: unknown; hint: unknown } => {
  if (!Result.isError(result)) {
    throw new TypeError("expected the lookup to be refused");
  }
  const body: unknown = JSON.parse(result.error.message);
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? body.error
      : null;
  const field = (name: string): unknown =>
    typeof error === "object" && error !== null && name in error
      ? Object.getOwnPropertyDescriptor(error, name)?.value
      : null;
  return {
    message: String(field("message")),
    code: field("code"),
    hint: field("hint"),
  };
};

describe("scopeBusinessRegistryLookup", () => {
  it("pins the one named registry when the call names none", () => {
    expect(
      scopeBusinessRegistryLookup({
        registries: [ARES],
        jurisdiction: "CZ",
        registry: undefined,
      }).unwrap(),
    ).toBe("ares");
  });

  it("pins the named registry that serves the jurisdiction among several", () => {
    expect(
      scopeBusinessRegistryLookup({
        registries: [ARES, BRREG],
        jurisdiction: "NO",
        registry: undefined,
      }).unwrap(),
    ).toBe("brreg");
  });

  it("keeps a call that names a named registry for its own jurisdiction", () => {
    expect(
      scopeBusinessRegistryLookup({
        registries: [ORSR, RPO],
        jurisdiction: "SK",
        registry: "rpo",
      }).unwrap(),
    ).toBe("rpo");
  });

  it("refuses a registry the chips do not name, with the allowed call as the hint", () => {
    const refused = refusal(
      scopeBusinessRegistryLookup({
        registries: [ARES],
        jurisdiction: "SK",
        registry: "orsr",
      }),
    );

    expect(refused.code).toBe("validation_error");
    expect(refused.message).toContain("orsr is not one of them");
    expect(refused.hint).toBe(
      "Call it with jurisdiction CZ with registry ares.",
    );
  });

  it("refuses a jurisdiction no named registry serves", () => {
    const refused = refusal(
      scopeBusinessRegistryLookup({
        registries: [ARES],
        jurisdiction: "NO",
        registry: undefined,
      }),
    );

    expect(refused.code).toBe("validation_error");
    expect(refused.message).toContain("None of them serves NO");
    expect(refused.hint).toBe(
      "Call it with jurisdiction CZ with registry ares.",
    );
  });

  it("refuses a named registry asked for another jurisdiction", () => {
    const refused = refusal(
      scopeBusinessRegistryLookup({
        registries: [ARES, BRREG],
        jurisdiction: "NO",
        registry: "ares",
      }),
    );

    expect(refused.hint).toBe(
      "Call it with jurisdiction CZ with registry ares.",
    );
  });

  it("asks for a choice when several named registries serve the jurisdiction", () => {
    expect(
      refusal(
        scopeBusinessRegistryLookup({
          registries: [ORSR, RPO],
          jurisdiction: "SK",
          registry: undefined,
        }),
      ).hint,
    ).toBe("Set registry to orsr or rpo.");
  });
});

describe("scopedRegistries", () => {
  it("is null on an unscoped turn and the named, enabled ones otherwise", () => {
    expect(scopedRegistries({ scopes: [], enabled: ENABLED })).toBeNull();
    expect(
      scopedRegistries({
        scopes: [
          { kind: "registry", registry: "brreg" },
          { kind: "registry", registry: "krs" },
          { kind: "corpus", corpus: "case_law", country: "CZE" },
        ],
        enabled: ENABLED,
      }),
    ).toEqual([BRREG]);
  });

  it("gives the lookup no per-call scope on an unscoped turn", () => {
    expect(businessRegistryCallScope(null)).toBeUndefined();
    expect(
      businessRegistryCallScope([ARES])?.({
        jurisdiction: "CZ",
        registry: undefined,
      }).unwrap(),
    ).toBe("ares");
  });
});

describe("restrictChatToolsToSourceScope", () => {
  it("keeps every tool on an unscoped turn", () => {
    expect(
      restrictChatToolsToSourceScope(TOOLS, {
        scopes: [],
        externalToolNames: EXTERNAL_TOOL_NAMES,
        connectors: CONNECTORS,
        registries: null,
      }),
    ).toBe(TOOLS);
  });

  it("keeps the lookup and drops corpora, connectors and the counterparty check under a registry chip", () => {
    // The check reads insolvency, VAT and sanctions sources no chip names.
    expect(restrict([{ kind: "registry", registry: "ares" }])).toEqual([
      "execute_typescript",
      "list_matters_direct",
      "business_registry_lookup",
    ]);
  });

  it("keeps only the named connector's own tools, whatever they are called", () => {
    expect(
      restrict([{ kind: "connector", connector: "legal-search" }]),
    ).toEqual([
      "execute_typescript",
      "list_matters_direct",
      "mcp__legal-search__find",
      "lookup_any",
    ]);
  });

  it("holds corpus and registry chips together", () => {
    expect(
      restrict([
        { kind: "corpus", corpus: "case_law", country: "CZE" },
        { kind: "registry", registry: "ares" },
      ]),
    ).toEqual([
      "execute_typescript",
      "list_matters_direct",
      "business_registry_lookup",
      "infosoud_lookup_case",
    ]);
  });

  it("drops the lookup when no named registry is enabled", () => {
    expect(restrict([{ kind: "registry", registry: "krs" }])).not.toContain(
      "business_registry_lookup",
    );
  });

  it("reports what it drops, for script calls", () => {
    expect(
      sourceScopeDroppedTools({
        scopes: [{ kind: "connector", connector: "notes" }],
        externalToolNames: EXTERNAL_TOOL_NAMES,
        connectors: CONNECTORS,
        registries: [],
      }).toSorted(),
    ).toEqual(
      [
        "boe_find_related_laws",
        "boe_get_law",
        "boe_get_law_block",
        "boe_get_law_structure",
        "boe_search_legislation",
        "borme_get_summary",
        "business_registry_lookup",
        "counterparty_check",
        "infosoud_lookup_case",
        "lookup_any",
        "mcp__legal-search__find",
        "search_boe_legislation",
      ].toSorted(),
    );
  });
});

describe("scopedExternalConnectors", () => {
  it("tells the model only about the connectors it may call", () => {
    const kept = scopedExternalConnectors(
      [
        { kind: "connector", connector: "notes" },
        { kind: "registry", registry: "ares" },
      ],
      CONNECTORS,
    );
    const hint = buildExternalMcpSystemHint(kept);

    expect(kept).toEqual([NOTES]);
    expect(hint).toContain("Notes");
    expect(hint).not.toContain("Legal Search");
  });

  it("keeps every connector on an unscoped turn and none under other chips", () => {
    expect(scopedExternalConnectors([], CONNECTORS)).toEqual(CONNECTORS);
    expect(
      buildExternalMcpSystemHint(
        scopedExternalConnectors(
          [{ kind: "corpus", corpus: "legislation", country: "CZE" }],
          CONNECTORS,
        ),
      ),
    ).toBe("");
  });
});
