import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import { describe, expect, it } from "bun:test";
import * as v from "valibot";

import type { ChatCorpusScope } from "@stll/api-contract";

import { createBoeTools } from "@/api/handlers/chat/tools/boe-tools";
import {
  corpusScopeDroppedTools,
  PUBLIC_SOURCE_JURISDICTIONS,
  restrictChatToolsToCorpusScope,
  scopeCorpusRead,
} from "@/api/handlers/chat/tools/corpus-scope";
import { createInfosoudTools } from "@/api/handlers/chat/tools/infosoud-tools";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";

const CZECH_CASE_LAW: ChatCorpusScope[] = [
  { corpus: "case_law", country: "CZE" },
];

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
  it("passes every read through on an unscoped turn", () => {
    const read = scopeCorpusRead({
      scopes: [],
      toolName: "search_legislation",
      args: { query: "nájem", country: "SVK" },
    });

    expect(read.unwrap()).toEqual({ query: "nájem", country: "SVK" });
  });

  it("keeps a call that names the scoped country", () => {
    const read = scopeCorpusRead({
      scopes: CZECH_CASE_LAW,
      toolName: "search_case_law",
      args: { queries: ["nájem"], country: "CZE" },
    });

    expect(read.unwrap()).toEqual({ queries: ["nájem"], country: "CZE" });
  });

  it("pins an omitted optional country to the single scoped one", () => {
    const read = scopeCorpusRead({
      scopes: CZECH_CASE_LAW,
      toolName: "case_law_coverage",
      args: {},
    });

    expect(read.unwrap()).toEqual({ country: "CZE" });
  });

  it("refuses an omitted optional country when several are scoped", () => {
    const read = scopeCorpusRead({
      scopes: [...CZECH_CASE_LAW, { corpus: "case_law", country: "SVK" }],
      toolName: "case_law_coverage",
      args: {},
    });

    expect(Result.isError(read)).toBe(true);
  });

  it("refuses a foreign country with a hint naming the allowed ones", () => {
    const read = scopeCorpusRead({
      scopes: CZECH_CASE_LAW,
      toolName: "search_case_law",
      args: { queries: ["nájem"], country: "SVK" },
    });

    if (!Result.isError(read)) {
      throw new TypeError("expected the foreign country to be refused");
    }
    expect(read.error.kind).toBe("invalid-input");
    expect(JSON.parse(read.error.message)).toMatchObject({
      error: {
        code: "validation_error",
        hint: "Set `country` to CZE.",
      },
    });
  });

  it("keeps id-keyed reads of the scoped corpus", () => {
    const read = scopeCorpusRead({
      scopes: CZECH_CASE_LAW,
      toolName: "read_case_law_citations",
      args: { decision_id: "id", direction: "cited_by" },
    });

    expect(Result.isOk(read)).toBe(true);
  });

  it("refuses the other corpus and other public corpora", () => {
    for (const toolName of [
      "search_legislation",
      "read_statute",
      "search_boe_legislation",
    ] as const) {
      const read = scopeCorpusRead({
        scopes: CZECH_CASE_LAW,
        toolName,
        args: {},
      });

      if (!Result.isError(read)) {
        throw new TypeError(`expected ${toolName} to be refused`);
      }
      expect(read.error.kind).toBe("unavailable");
    }
  });

  it("holds each corpus to its own countries when both are scoped", () => {
    const scopes: ChatCorpusScope[] = [
      ...CZECH_CASE_LAW,
      { corpus: "legislation", country: "SVK" },
    ];

    expect(
      Result.isOk(
        scopeCorpusRead({
          scopes,
          toolName: "search_legislation",
          args: { query: "q", country: "SVK" },
        }),
      ),
    ).toBe(true);
    expect(
      Result.isError(
        scopeCorpusRead({
          scopes,
          toolName: "search_legislation",
          args: { query: "q", country: "CZE" },
        }),
      ),
    ).toBe(true);
  });

  it("leaves tenant reads alone", () => {
    const read = scopeCorpusRead({
      scopes: CZECH_CASE_LAW,
      toolName: "list_matters",
      args: { limit: 5 },
    });

    expect(read.unwrap()).toEqual({ limit: 5 });
  });
});

describe("restrictChatToolsToCorpusScope", () => {
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
      [{ corpus: "legislation", country: "CZE" }],
      [{ corpus: "case_law", country: "SVK" }],
    ] satisfies ChatCorpusScope[][]) {
      expect(
        Object.keys(restrictChatToolsToCorpusScope(tools, scopes)),
      ).toEqual(["execute_typescript", "list_matters_direct"]);
    }
  });

  it("keeps every tool on an unscoped turn", () => {
    expect(restrictChatToolsToCorpusScope(tools, [])).toBe(tools);
    expect(corpusScopeDroppedTools([])).toEqual([]);
  });

  it("holds script reads of other sources to the same jurisdictions", () => {
    expect(
      Result.isError(
        scopeCorpusRead({
          scopes: [{ corpus: "legislation", country: "CZE" }],
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
