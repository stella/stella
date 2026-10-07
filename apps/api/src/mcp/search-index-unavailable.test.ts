import { Result, UnhandledException } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ElysiaCustomStatusResponse } from "elysia";
import { readdirSync, readFileSync } from "node:fs";

import { env } from "@/api/env";
import { searchCorpusIndexDecisions } from "@/api/handlers/case-law/decisions/search";
import { searchLegislationHandler } from "@/api/handlers/legislation/search";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import { CorpusServingGenerationAbsentError } from "@/api/lib/legal-search/corpus-index-generation-store";
import { readCorpusIndexSearchPage } from "@/api/lib/legal-search/corpus-index-pagination";
import { corpusSearchGroupToken } from "@/api/lib/legal-search/corpus-search-cursor";
import { RELEVANCE_ORDER } from "@/api/lib/legal-search/corpus-search-order";
import {
  SEARCH_INDEX_UNAVAILABLE_HINT,
  SEARCH_INDEX_UNAVAILABLE_MESSAGE,
  searchIndexUnavailableError,
} from "@/api/lib/legal-search/search-index-unavailable";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { mapHandlerResult } from "@/api/mcp/capability-tools";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { MCP_ERROR_CODES } from "@/api/mcp/error-codes";
import type { McpToolResponse } from "@/api/mcp/tool-types";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import {
  internalFailureResult,
  MCP_INTERNAL_ERROR_HINT,
  serializeToolResult,
} from "@/api/mcp/tool-utils";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

/**
 * A search whose index cannot be reached answers every agent the same way:
 * `search_index_unavailable`, the cause in the message, a retry in the hint,
 * `retryable: true`. Never the opaque `internal_error`, which tells an agent
 * the server broke and that resending will not help.
 *
 * The seams below run the real client and the real scan against an engine
 * that refuses the connection, so the refusal travels the path it travels in
 * production: client, scan, tool handler, dispatch boundary.
 */

const WORKSPACE_ID = "00000000-0000-4000-8000-0000000a0001";

const EXPECTED_ENVELOPE = {
  error: {
    code: "search_index_unavailable",
    message: SEARCH_INDEX_UNAVAILABLE_MESSAGE,
    hint: SEARCH_INDEX_UNAVAILABLE_HINT,
    retryable: true,
  },
};

const originalFetch = globalThis.fetch;
const originalPublicLaw = env.FEATURE_PUBLIC_LAW;

beforeEach(() => {
  // The index is gone: every request to it is refused before an answer.
  globalThis.fetch = Object.assign(
    async () =>
      await Promise.reject(
        Object.assign(new Error("Unable to connect"), {
          code: "ConnectionRefused",
        }),
      ),
    { preconnect: originalFetch.preconnect },
  );
  env.FEATURE_PUBLIC_LAW = true;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  env.FEATURE_PUBLIC_LAW = originalPublicLaw;
});

/** A scan against the unreachable index, as both search handlers run one. */
const scanUnreachableIndex = async (): Promise<never> => {
  await readCorpusIndexSearchPage({
    observer: "unobserved",
    cluster: "q09",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    limit: 10,
    order: RELEVANCE_ORDER,
    parsedCursor: null,
    snippetFields: ["text"],
    extractId: (hit) =>
      typeof hit["document_id"] === "string" ? hit["document_id"] : null,
    extractSnippet: () => null,
    unseenScoreUpperBound: () => 0,
    rankCandidates: async (candidates) =>
      await Promise.resolve({
        context: null,
        groups: candidates.map((candidate) =>
          corpusSearchGroupToken(candidate.id),
        ),
        ranked: [],
      }),
  });
  throw new Error("the scan succeeded against an unreachable index");
};

const createContext = (): McpRequestContext => {
  const { safeDb, scopedDb } = createScopedDbMock({
    query: {
      organizationSettings: {
        findFirst: async () => await Promise.resolve(undefined),
      },
    },
  });
  return {
    accessibleWorkspaceIds: [toSafeId<"workspace">(WORKSPACE_ID)],
    accessibleWorkspaceIdSet: new Set([WORKSPACE_ID]),
    accessibleWorkspaceStatusById: new Map([[WORKSPACE_ID, "active"]]),
    accessibleWorkspaces: [],
    grantedScopes: [],
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    recordAuditEvent: asTestRaw(async () => await Promise.resolve(undefined)),
    safeDb,
    scopedDb,
    thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
    testDependencies: {
      getSearchReader: asTestRaw(() => ({
        search: async () =>
          await Promise.resolve({ hits: [], nextCursor: null }),
        searchContent: async () =>
          await Promise.resolve({ hits: [], totalCount: 0 }),
      })),
      readCaseLawCourtNames: async () => await Promise.resolve([]),
      searchDecisionsHandler: asTestRaw(scanUnreachableIndex),
      searchLegislationHandler: asTestRaw(scanUnreachableIndex),
    },
    userId: toSafeId<"user">("user_1"),
    userEmail: "standard@example.test",
  };
};

const payloadOf = (result: { content: readonly unknown[] }): unknown => {
  const first = result.content.at(0);
  if (
    typeof first !== "object" ||
    first === null ||
    !("text" in first) ||
    typeof first.text !== "string"
  ) {
    throw new Error("Expected a text MCP response");
  }
  return JSON.parse(first.text);
};

const serialized = (response: McpToolResponse) => {
  if (isMcpEgressPlan(response)) {
    throw new Error("expected a CallToolResult, got an egress plan");
  }
  return serializeToolResult(response);
};

/**
 * Every MCP tool that queries the public-law search index, keyed by the
 * source file that reaches it through a search seam. The census below fails
 * when a file starts reaching the index without a row here, so a new search
 * tool cannot land without proving its answer to an unreachable index.
 */
const INDEX_BACKED_TOOLS: readonly {
  file: string;
  toolName: string;
  mode: McpMode;
  args: Record<string, unknown>;
}[] = [
  {
    file: "stella-tools.ts",
    toolName: "search_case_law",
    mode: "default",
    args: { country: "CZE", queries: ["smlouva"] },
  },
  {
    file: "legislation-tools.ts",
    toolName: "search_legislation",
    mode: "default",
    args: { country: "CZE", query: "smlouva" },
  },
  {
    file: "compat-corpus.ts",
    toolName: "search",
    mode: "default",
    args: { query: "smlouva" },
  },
  {
    file: "compat-corpus.ts",
    toolName: "search",
    mode: "law",
    args: { query: "smlouva" },
  },
];

/** The seams that put a tool on the search index. */
const INDEX_SEAMS = [
  "defaultSearchDecisionsHandler",
  "defaultSearchLegislationHandler",
] as const;

/** Where the seams are defined rather than used. */
const SEAM_OWNER = "public-law-handlers.ts";

describe("search_index_unavailable", () => {
  test("is one of the closed envelope codes", () => {
    expect(MCP_ERROR_CODES).toContain("search_index_unavailable");
  });

  test("search_case_law with an unreachable index returns the typed, retryable envelope", async () => {
    const result = await handleMcpToolCall({
      args: { country: "CZE", queries: ["smlouva"] },
      context: createContext(),
      mode: "default",
      toolName: "search_case_law",
    });

    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toEqual(EXPECTED_ENVELOPE);
  });

  for (const tool of INDEX_BACKED_TOOLS) {
    test(`${tool.toolName} (${tool.mode}) maps an unreachable index`, async () => {
      const result = await handleMcpToolCall({
        args: tool.args,
        context: createContext(),
        mode: tool.mode,
        toolName: tool.toolName,
      });

      expect(result.isError).toBe(true);
      expect(payloadOf(result)).toEqual(EXPECTED_ENVELOPE);
    });
  }

  describe("with no serving generation", () => {
    const absent = (family: CorpusFamily) =>
      Result.err(
        new CorpusServingGenerationAbsentError({
          message: `No serving corpus generation: ${family}`,
          family,
        }),
      );
    /** The generation read refuses before any engine request is made. */
    const requested: string[] = [];
    const contextWithoutServingGeneration = (): McpRequestContext => {
      requested.length = 0;
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request) => {
          requested.push(input instanceof Request ? input.url : String(input));
          return await Promise.resolve(Response.json({}, { status: 500 }));
        },
        { preconnect: originalFetch.preconnect },
      );
      const context = createContext();
      return {
        ...context,
        testDependencies: {
          ...context.testDependencies,
          searchDecisionsHandler: async ({ body, caseLawDb, observer }) =>
            await searchCorpusIndexDecisions({
              body,
              caseLawDb,
              observer,
              dependencies: {
                readServingTarget: async () =>
                  await Promise.resolve(absent("case_law")),
              },
            }),
          searchLegislationHandler: async (body, _legislationDb, observer) =>
            await searchLegislationHandler(
              body,
              asTestRaw<LegislationReadDb>(
                async (run: (tx: unknown) => Promise<unknown>) =>
                  await run(null),
              ),
              observer,
              {
                provider: "corpus-index",
                loadSearchConfigs: async () => await Promise.resolve([]),
                readServingGeneration: async (_tx, family) =>
                  await Promise.resolve(absent(family)),
              },
            ),
        },
      };
    };

    for (const tool of INDEX_BACKED_TOOLS) {
      test(`${tool.toolName} (${tool.mode}) returns the typed, retryable envelope`, async () => {
        const result = await handleMcpToolCall({
          args: tool.args,
          context: contextWithoutServingGeneration(),
          mode: tool.mode,
          toolName: tool.toolName,
        });

        expect(requested).toEqual([]);
        expect(result.isError).toBe(true);
        expect(payloadOf(result)).toEqual(EXPECTED_ENVELOPE);
      });
    }
  });

  test("every MCP source that reaches the search index is in the table", () => {
    const directory = new URL(".", import.meta.url);
    const reaching = readdirSync(directory)
      .filter(
        (file) =>
          file.endsWith(".ts") &&
          !file.endsWith(".test.ts") &&
          file !== SEAM_OWNER,
      )
      .filter((file) => {
        const source = readFileSync(new URL(file, directory), "utf-8");
        return INDEX_SEAMS.some((seam) => source.includes(seam));
      })
      .toSorted();

    expect(reaching).toEqual(
      [...new Set(INDEX_BACKED_TOOLS.map(({ file }) => file))].toSorted(),
    );
  });

  test("a capability's 503 body with the code maps to the envelope", () => {
    const refusal = searchIndexUnavailableError(new Error("refused"));
    const response = mapHandlerResult({
      id: "legislation.search",
      access: "read",
      result: new ElysiaCustomStatusResponse(503, {
        code: refusal.code,
        message: refusal.message,
        hint: refusal.hint,
        retryable: refusal.retryable,
      }),
    });

    expect(payloadOf(serialized(response))).toEqual(EXPECTED_ENVELOPE);
  });

  test("a failed Result carrying the refusal maps to the envelope", () => {
    const response = internalFailureResult(
      new UnhandledException({
        cause: searchIndexUnavailableError(new Error("refused")),
      }),
    );

    expect(payloadOf(serialized(response))).toEqual(EXPECTED_ENVELOPE);
  });

  test("a genuine server failure stays internal_error", () => {
    for (const error of [
      new Error("undefined is not a function"),
      new HandlerError({
        status: 503,
        message: "Search is temporarily unavailable",
      }),
    ]) {
      const payload = payloadOf(serialized(internalFailureResult(error)));
      expect(payload).toEqual({
        error: {
          code: "internal_error",
          message: "Tool execution failed",
          hint: MCP_INTERNAL_ERROR_HINT,
        },
      });
    }
  });
});
