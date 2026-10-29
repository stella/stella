import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import { describe, expect, it } from "bun:test";
import * as v from "valibot";

import type { ChatSourceScope } from "@stll/api-contract";

import { createBoeTools } from "@/api/handlers/chat/tools/boe-tools";
import {
  type CorpusResourceCountryResolver,
  corpusScopeDroppedTools,
  PUBLIC_SOURCE_JURISDICTIONS,
  scopeCorpusRead,
} from "@/api/handlers/chat/tools/corpus-scope";
import { createInfosoudTools } from "@/api/handlers/chat/tools/infosoud-tools";
import type { RegistryReadToolName } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import { restrictChatToolsToSourceScope } from "@/api/handlers/chat/tools/source-scope";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";

const CZECH_CASE_LAW: ChatSourceScope[] = [
  { kind: "corpus", corpus: "case_law", country: "CZE" },
];
const CZECH_LEGISLATION: ChatSourceScope[] = [
  { kind: "corpus", corpus: "legislation", country: "CZE" },
];

const CZECH_DECISION = "0f6c2a1e-5b7d-4c1e-9a7b-1d2e3f4a5b6c";
const SLOVAK_DECISION = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const UNKNOWN_DECISION = "11111111-2222-4333-8444-555555555555";
const CZECH_ELI = "https://www.e-sbirka.cz/eli/cz/sb/2012/89";
const SLOVAK_ELI =
  "https://www.slov-lex.sk/ezbierky/pravne-predpisy/SK/ZZ/1964/40";

const lookup =
  (rows: Record<string, string>) =>
  async (keys: readonly string[]): Promise<ReadonlyMap<string, string>> =>
    await Promise.resolve(
      new Map(
        keys.flatMap((key) => {
          const country = rows[key];
          return country === undefined ? [] : [[key, country] as const];
        }),
      ),
    );

/** The stored countries a keyed read is checked against. */
const RESOLVER: CorpusResourceCountryResolver = {
  decisions: lookup({ [CZECH_DECISION]: "CZE", [SLOVAK_DECISION]: "SVK" }),
  statutes: lookup({ [CZECH_ELI]: "CZE", [SLOVAK_ELI]: "SVK" }),
};

const scope = async (props: {
  scopes: readonly ChatSourceScope[];
  toolName: RegistryReadToolName;
  args: Record<string, unknown>;
}) => await scopeCorpusRead({ ...props, resolveCountries: RESOLVER });

/** The refusal's hint, failing the test when the read was not refused. */
const refusalHint = (
  read: Awaited<ReturnType<typeof scope>>,
): { kind: string; code: unknown; hint: unknown } => {
  if (!Result.isError(read)) {
    throw new TypeError("expected the read to be refused");
  }
  const body: unknown = JSON.parse(read.error.message);
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? body.error
      : null;
  return {
    kind: read.error.kind,
    code:
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : null,
    hint:
      typeof error === "object" && error !== null && "hint" in error
        ? error.hint
        : null,
  };
};

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

describe("scopeCorpusRead", () => {
  it("passes every read through on an unscoped turn", async () => {
    const read = await scope({
      scopes: [],
      toolName: "read_case_law_decision",
      args: { decision_ids: [SLOVAK_DECISION] },
    });

    expect(read.unwrap()).toEqual({ decision_ids: [SLOVAK_DECISION] });
  });

  it("keeps a call that names the scoped country", async () => {
    const read = await scope({
      scopes: CZECH_CASE_LAW,
      toolName: "search_case_law",
      args: { queries: ["nájem"], country: "CZE" },
    });

    expect(read.unwrap()).toEqual({ queries: ["nájem"], country: "CZE" });
  });

  it("pins an omitted optional country to the single scoped one", async () => {
    const read = await scope({
      scopes: CZECH_CASE_LAW,
      toolName: "case_law_coverage",
      args: {},
    });

    expect(read.unwrap()).toEqual({ country: "CZE" });
  });

  it("refuses an omitted optional country when several are scoped", async () => {
    const read = await scope({
      scopes: [
        ...CZECH_CASE_LAW,
        { kind: "corpus", corpus: "case_law", country: "SVK" },
      ],
      toolName: "case_law_coverage",
      args: {},
    });

    expect(Result.isError(read)).toBe(true);
  });

  it("refuses a foreign country with a hint naming the allowed ones", async () => {
    const read = await scope({
      scopes: CZECH_CASE_LAW,
      toolName: "search_case_law",
      args: { queries: ["nájem"], country: "SVK" },
    });

    expect(refusalHint(read)).toEqual({
      kind: "invalid-input",
      code: "validation_error",
      hint: "Set `country` to CZE.",
    });
  });

  it("keeps decision reads whose stored country is in scope", async () => {
    for (const [toolName, args] of [
      ["read_case_law_decision", { decision_ids: [CZECH_DECISION] }],
      [
        "read_case_law_citations",
        { decision_id: CZECH_DECISION, direction: "cited_by" },
      ],
    ] as const) {
      const read = await scope({ scopes: CZECH_CASE_LAW, toolName, args });

      expect(read.unwrap()).toEqual(args);
    }
  });

  it("refuses a foreign decision id under a Czech chip, citations included", async () => {
    for (const [toolName, args] of [
      [
        "read_case_law_decision",
        { decision_ids: [CZECH_DECISION, SLOVAK_DECISION] },
      ],
      [
        "read_case_law_citations",
        { decision_id: SLOVAK_DECISION, direction: "cites" },
      ],
    ] as const) {
      const refusal = refusalHint(
        await scope({ scopes: CZECH_CASE_LAW, toolName, args }),
      );

      expect(refusal.code).toBe("validation_error");
      expect(refusal.hint).toContain("SVK");
      expect(refusal.hint).toContain("search_case_law in CZE");
    }
  });

  it("refuses a decision id the store does not know", async () => {
    for (const id of [UNKNOWN_DECISION, "not-a-uuid"]) {
      const refusal = refusalHint(
        await scope({
          scopes: CZECH_CASE_LAW,
          toolName: "read_case_law_decision",
          args: { decision_ids: [id] },
        }),
      );

      expect(refusal).toEqual({
        kind: "invalid-input",
        code: "validation_error",
        hint: "Find it with search_case_law in CZE first.",
      });
    }
  });

  it("holds statute reads to the stored country of their ELI", async () => {
    expect(
      (
        await scope({
          scopes: CZECH_LEGISLATION,
          toolName: "read_statute",
          args: { eli: CZECH_ELI },
        })
      ).unwrap(),
    ).toEqual({ eli: CZECH_ELI });
    expect(
      refusalHint(
        await scope({
          scopes: CZECH_LEGISLATION,
          toolName: "read_statute",
          args: { eli: SLOVAK_ELI },
        }),
      ).hint,
    ).toContain("SVK");
    expect(
      refusalHint(
        await scope({
          scopes: CZECH_LEGISLATION,
          toolName: "read_provision_history",
          args: { eli: "https://example.com/eli/unknown", anchor: "p1" },
        }),
      ).hint,
    ).toBe("Find it with search_legislation in CZE first.");
  });

  it("refuses a provision batch when any entry is foreign", async () => {
    const read = await scope({
      scopes: CZECH_LEGISLATION,
      toolName: "read_statute_provisions",
      args: {
        items: [
          { eli: CZECH_ELI, anchor: "p1" },
          { eli: SLOVAK_ELI, anchor: "p2" },
        ],
      },
    });

    expect(refusalHint(read).hint).toContain("SVK");
  });

  it("refuses the other corpus and other public corpora", async () => {
    for (const toolName of [
      "search_legislation",
      "read_statute",
      "search_boe_legislation",
    ] as const) {
      const read = await scope({
        scopes: CZECH_CASE_LAW,
        toolName,
        args: {},
      });

      expect(Result.isError(read) && read.error.kind).toBe("unavailable");
    }
  });

  it("holds each corpus to its own countries when both are scoped", async () => {
    const scopes: ChatSourceScope[] = [
      ...CZECH_CASE_LAW,
      { kind: "corpus", corpus: "legislation", country: "SVK" },
    ];

    expect(
      Result.isOk(
        await scope({
          scopes,
          toolName: "search_legislation",
          args: { query: "q", country: "SVK" },
        }),
      ),
    ).toBe(true);
    expect(
      Result.isError(
        await scope({
          scopes,
          toolName: "search_legislation",
          args: { query: "q", country: "CZE" },
        }),
      ),
    ).toBe(true);
  });

  it("refuses every corpus read on a turn whose chips name only a registry", async () => {
    for (const toolName of [
      "search_case_law",
      "search_legislation",
      "search_boe_legislation",
    ] as const) {
      const read = await scope({
        scopes: [{ kind: "registry", registry: "ares" }],
        toolName,
        args: { query: "q", country: "CZE" },
      });

      expect(Result.isError(read) && read.error.kind).toBe("unavailable");
    }
  });

  it("leaves tenant reads alone", async () => {
    const read = await scope({
      scopes: CZECH_CASE_LAW,
      toolName: "list_matters",
      args: { limit: 5 },
    });

    expect(read.unwrap()).toEqual({ limit: 5 });
  });

  it("returns a failed country lookup as a retryable error, never a rejection", async () => {
    const read = await scopeCorpusRead({
      scopes: CZECH_CASE_LAW,
      toolName: "read_case_law_decision",
      args: { decision_ids: [CZECH_DECISION] },
      resolveCountries: {
        ...RESOLVER,
        decisions: async () => {
          throw new Error("public database unavailable");
        },
      },
    });

    expect(Result.isError(read) && read.error.kind).toBe("transient");
  });
});

/** The public-source drops alone: no registries, no connectors loaded. */
const restrictChatToolsToCorpusScope = (
  tools: ChatToolMap,
  scopes: readonly ChatSourceScope[],
): ChatToolMap =>
  restrictChatToolsToSourceScope(tools, {
    scopes,
    externalToolNames: [],
    connectors: [],
    registries: null,
  });

describe("public sources under corpus chips", () => {
  const tools = toolMap([
    "execute_typescript",
    "list_matters_direct",
    "boe_search_legislation",
    "infosoud_lookup_case",
  ]);

  it("keeps InfoSoud beside a Czech case-law chip and drops Spain's BOE", () => {
    expect(
      Object.keys(restrictChatToolsToCorpusScope(tools, CZECH_CASE_LAW)),
    ).toEqual([
      "execute_typescript",
      "list_matters_direct",
      "infosoud_lookup_case",
    ]);
  });

  it("drops InfoSoud when no chip names Czech case law", () => {
    for (const scopes of [
      CZECH_LEGISLATION,
      [{ kind: "corpus", corpus: "case_law", country: "SVK" }],
    ] satisfies ChatSourceScope[][]) {
      expect(
        Object.keys(restrictChatToolsToCorpusScope(tools, scopes)),
      ).toEqual(["execute_typescript", "list_matters_direct"]);
    }
  });

  it("keeps every tool on an unscoped turn", () => {
    expect(restrictChatToolsToCorpusScope(tools, [])).toBe(tools);
    expect(corpusScopeDroppedTools([])).toEqual([]);
  });

  it("holds script reads of other sources to the same jurisdictions", async () => {
    expect(
      Result.isError(
        await scope({
          scopes: CZECH_LEGISLATION,
          toolName: "search_boe_legislation",
          args: {},
        }),
      ),
    ).toBe(true);
  });

  it("gives every native BOE, BORME and InfoSoud tool a jurisdiction", () => {
    for (const name of Object.keys({
      ...createBoeTools(),
      ...createInfosoudTools(),
    })) {
      expect(Object.hasOwn(PUBLIC_SOURCE_JURISDICTIONS, name)).toBe(true);
    }
  });
});
