import type { CallToolResult } from "@modelcontextprotocol/server";
import { panic, Result, UnhandledException } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import {
  SEARCH_PAGE_REACH,
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_TOTAL_NOT_COUNTED,
} from "@stll/api-contract/search";

import { PUBLIC_READ_STATEMENT_TIMEOUT_MS } from "@/api/db/shared-pool-timeouts";
import { env } from "@/api/env";
import { searchCorpusIndexDecisions } from "@/api/handlers/case-law/decisions/search";
import { searchLegislationHandler } from "@/api/handlers/legislation/search";
import { HttpStatusResponse } from "@/api/http/status";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import { CorpusServingGenerationAbsentError } from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  NATIVE_SCAN_TRANSPORT,
  readCorpusIndexSearchPage,
} from "@/api/lib/legal-search/corpus-index-pagination";
import { corpusSearchGroupToken } from "@/api/lib/legal-search/corpus-search-cursor";
import { RELEVANCE_ORDER } from "@/api/lib/legal-search/corpus-search-order";
import { PublicLawStatementError } from "@/api/lib/legal-search/public-law-statement-error";
import {
  getPublicReadSignal,
  getPublicReadStatementTimeoutMs,
  runWithPublicReadStatementTimeout,
} from "@/api/lib/legal-search/public-read-timeout-context";
import {
  isSearchIndexUnavailable,
  SEARCH_INDEX_UNAVAILABLE_HINT,
  SEARCH_INDEX_UNAVAILABLE_MESSAGE,
  searchIndexUnavailableError,
} from "@/api/lib/legal-search/search-index-unavailable";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import {
  flushFailureObservations,
  resetFailureObservationsForTesting,
} from "@/api/lib/observability/failure-shadow";
import { RELEASE_SCRIPT } from "@/api/lib/rate-limit/concurrency-lease";
import { withMcpPublicReadAdmission } from "@/api/lib/rate-limit/mcp-public-read-admission";
import { mapHandlerResult } from "@/api/mcp/capability-tools";
import type { McpMode } from "@/api/mcp/constants";
import { MCP_ERROR_CODES } from "@/api/mcp/error-codes";
import {
  LAW_MCP_TOOL_DISPOSITION,
  MCP_PUBLIC_CORPUS_CLASS,
} from "@/api/mcp/static-tool-definitions";
import type { McpToolResponse } from "@/api/mcp/tool-types";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import {
  internalFailureResult,
  MCP_INTERNAL_ERROR_HINT,
  serializeToolResult,
} from "@/api/mcp/tool-utils";
import { handleMcpToolCall } from "@/api/mcp/tools";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
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
    scanTransport: NATIVE_SCAN_TRANSPORT,
    observer: "unobserved",
    cluster: "q09",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    limit: 10,
    order: RELEVANCE_ORDER,
    parsedCursor: null,
    snippetFields: ["text"],
    projectionRevisionField: "projection_revision",
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
        revisionById: new Map(),
      }),
  });
  throw new Error("the scan succeeded against an unreachable index");
};

const createContext = (): AuthorizedMcpRequestContext => {
  const { safeDb, scopedDb } = createScopedDbMock({
    query: {
      organizationSettings: {
        findFirst: async () => await Promise.resolve(undefined),
      },
    },
  });
  return authorizedMcpContextForTest({
    accessibleWorkspaceIds: [toSafeId<"workspace">(WORKSPACE_ID)],
    accessibleWorkspaceIdSet: new Set([WORKSPACE_ID]),
    accessibleWorkspaceStatusById: new Map([[WORKSPACE_ID, "active"]]),
    accessibleWorkspaces: [],
    grantedScopes: ["stella:read", "stella:search", "stella:knowledge_write"],
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
  });
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
    const contextWithoutServingGeneration = (): AuthorizedMcpRequestContext => {
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

    test("both search handlers return the REST body of the thrown refusal", async () => {
      const { testDependencies } = contextWithoutServingGeneration();
      const searchDecisions = testDependencies?.searchDecisionsHandler;
      const searchLegislation = testDependencies?.searchLegislationHandler;
      if (searchDecisions === undefined || searchLegislation === undefined) {
        throw new Error("expected both search seams");
      }
      const thrown = searchIndexUnavailableError(new Error("absent"));
      const outcomes = [
        await searchDecisions({
          body: { query: "smlouva", country: "CZE", limit: 1 },
          caseLawDb: Object.assign(
            async () => panic("An absent generation must not read decisions"),
            caseLawPublicReadDb,
          ),
          observer: "unobserved",
        }),
        await searchLegislation(
          { query: "smlouva", jurisdiction: "CZE", limit: 1 },
          asTestRaw<LegislationReadDb>(async () =>
            panic("The seam supplies its own generation read"),
          ),
          "unobserved",
        ),
      ];

      expect(requested).toEqual([]);
      for (const outcome of outcomes) {
        expect(outcome).toBeInstanceOf(HttpStatusResponse);
        expect(outcome).toMatchObject({
          code: thrown.status,
          response: {
            code: thrown.code,
            message: thrown.message,
            hint: thrown.hint,
            retryable: thrown.retryable,
          },
        });
        expect(isSearchIndexUnavailable(outcome)).toBe(true);
      }
    });

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
      result: new HttpStatusResponse(503, {
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
      "mcp.response.failure",
    );

    expect(payloadOf(serialized(response))).toEqual(EXPECTED_ENVELOPE);
  });

  test("a genuine server failure stays internal_error", () => {
    for (const error of [
      new Error("undefined is not a function"),
      new HandlerError({
        status: 503,
        code: "internal_error",
        message: "Search is temporarily unavailable",
      }),
    ]) {
      const payload = payloadOf(
        serialized(internalFailureResult(error, "mcp.payload.error")),
      );
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

describe("public corpus statement budgets", () => {
  test("a scoped annotation cancellation keeps its own error inside a public-read budget", async () => {
    const context = createContext();
    let reached = false;
    const result = await handleMcpToolCall({
      toolName: "list_reader_annotations",
      args: { target_type: "decision", target_id: WORKSPACE_ID },
      context: {
        ...context,
        safeDb: async () => {
          reached = true;
          expect(getPublicReadStatementTimeoutMs()).toBe(
            PUBLIC_READ_STATEMENT_TIMEOUT_MS.browse,
          );
          return Result.err(
            new UnhandledException({
              cause: new DatabaseError({
                message: "Workspace statement failed",
                cause: Object.assign(
                  new Error("workspace statement cancelled"),
                  {
                    code: "57014",
                  },
                ),
              }),
            }),
          );
        },
        testDependencies: {
          ...context.testDependencies,
          resolveAnnotationTarget: async () => ({
            status: "available",
            readBlocks: async () => [],
          }),
        },
      },
    });
    expect(reached).toBe(true);
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({
      error: { code: "internal_error" },
    });
  });

  test("a denied corpus call does not enter admission", async () => {
    let admissions = 0;
    const result = await handleMcpToolCall({
      toolName: "create_reader_annotation",
      args: {},
      context: { ...createContext(), memberRole: "external" },
      dependencies: {
        admitPublicRead: async () => {
          admissions += 1;
          return Result.err(
            new ActionAdmissionError({
              reason: "busy",
              message: "Concurrent reads in progress",
              retryAfterMs: 1250,
            }),
          );
        },
        dispatchGatewayToolCall: async () => null,
      },
    });
    expect(payloadOf(result)).toMatchObject({
      error: { code: "permission_denied" },
    });
    expect(admissions).toBe(0);
  });

  test("every corpus disposition runs at dispatch under its class budget", async () => {
    const corpusTools = Object.entries(LAW_MCP_TOOL_DISPOSITION)
      .filter(([, disposition]) => disposition === "corpus")
      .map(([name]) => name)
      .toSorted();
    const classes = new Map(Object.entries(MCP_PUBLIC_CORPUS_CLASS));
    expect(corpusTools.filter((name) => !classes.has(name))).toEqual([]);
    expect(classes.has("search_boe_legislation")).toBe(false);
    const exercised: string[] = [];
    const admitted: string[] = [];
    for (const toolName of classes.keys()) {
      await handleMcpToolCall({
        toolName,
        args: {},
        context: createContext(),
        dependencies: {
          admitPublicRead: async ({ run }) => {
            admitted.push(toolName);
            return Result.ok({
              status: "leased",
              value: await run(new AbortController().signal),
            });
          },
          dispatchGatewayToolCall: async () => {
            exercised.push(toolName);
            expect(admitted.at(-1)).toBe(toolName);
            expect(getPublicReadSignal()).toBeDefined();
            const corpusClass = classes.get(toolName);
            if (corpusClass === undefined) {
              throw new Error("Missing corpus class");
            }
            expect(getPublicReadStatementTimeoutMs()).toBe(
              PUBLIC_READ_STATEMENT_TIMEOUT_MS[corpusClass],
            );
            await Promise.resolve();
            expect(getPublicReadStatementTimeoutMs()).toBe(
              PUBLIC_READ_STATEMENT_TIMEOUT_MS[corpusClass],
            );
            return null;
          },
        },
      });
      expect(getPublicReadStatementTimeoutMs()).toBeUndefined();
    }
    expect(exercised.toSorted()).toEqual([...classes.keys()].toSorted());
    expect(admitted.toSorted()).toEqual(exercised.toSorted());
  });

  test("upstream-only dispatch does not acquire a public-read budget", async () => {
    let reached = false;
    await handleMcpToolCall({
      toolName: "search_boe_legislation",
      args: {},
      context: createContext(),
      dependencies: {
        admitPublicRead: async () => {
          throw new Error("Upstream-only tool acquired a corpus slot");
        },
        dispatchGatewayToolCall: async () => {
          reached = true;
          expect(getPublicReadStatementTimeoutMs()).toBeUndefined();
          return null;
        },
      },
    });
    expect(reached).toBe(true);
  });

  test("busy public reads return retry advice without dispatching", async () => {
    let dispatched = false;
    const result = await handleMcpToolCall({
      toolName: "search_case_law",
      args: { country: "CZE", queries: ["smlouva"] },
      context: createContext(),
      dependencies: {
        admitPublicRead: async () =>
          Result.err(
            new ActionAdmissionError({
              reason: "busy",
              message: "Concurrent reads in progress",
              retryAfterMs: 1250,
            }),
          ),
        dispatchGatewayToolCall: async () => {
          dispatched = true;
          return null;
        },
      },
    });
    expect(dispatched).toBe(false);
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({
      error: {
        code: "action_concurrency_busy",
        retryable: true,
        retryAfterMs: 1250,
        hint: "Wait for active work to finish, then retry this call.",
      },
    });
  });

  test("degraded public-read admission preserves success and its statement budget", async () => {
    const analytics = installRecordingAnalytics();
    const logs = installRecordingLogger();
    const success = {
      content: [{ type: "text", text: "read complete" }],
    } satisfies CallToolResult;
    try {
      const result = await handleMcpToolCall({
        toolName: "search_case_law",
        args: {},
        context: createContext(),
        dependencies: {
          admitPublicRead: async (options) =>
            await withMcpPublicReadAdmission({
              ...options,
              redis: {
                send: async (_command, args) =>
                  args.at(0) === RELEASE_SCRIPT
                    ? 1
                    : await Promise.reject(
                        new TypeError("Coordination unavailable"),
                      ),
              },
            }),
          dispatchGatewayToolCall: async () => {
            expect(getPublicReadStatementTimeoutMs()).toBe(
              PUBLIC_READ_STATEMENT_TIMEOUT_MS.search,
            );
            return { type: "external_mcp", result: success };
          },
        },
      });
      expect(result).toEqual(success);
      expect(
        logs.records.filter(
          ({ message }) => message === "mcp.public_read.admission_degraded",
        ),
      ).toHaveLength(1);
      expect(analytics.exceptions()).toHaveLength(1);
    } finally {
      analytics.restore();
      logs.restore();
    }
  });

  test("a public-read lease cancellation keeps its typed admission outcome", async () => {
    const context = createContext();
    const result = await handleMcpToolCall({
      toolName: "search_case_law",
      args: { country: "CZE", queries: ["smlouva"] },
      context: {
        ...context,
        testDependencies: {
          ...context.testDependencies,
          searchDecisionsHandler: async () =>
            abortTransaction(
              new ActionAdmissionError({
                reason: "lease_lost",
                message: "Action lease was lost",
              }),
            ),
        },
      },
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({
      error: { code: "action_admission_lease_lost", retryable: true },
    });
  });

  test("one case-law search with several queries acquires one caller slot", async () => {
    let slots = 0;
    const queries = ["smlouva", "nájem", "škoda"];
    const searched: string[] = [];
    const context = createContext();
    const result = await handleMcpToolCall({
      toolName: "search_case_law",
      args: { country: "CZE", queries },
      context: {
        ...context,
        testDependencies: {
          ...context.testDependencies,
          searchDecisionsHandler: async ({ body }) => {
            expect(slots).toBe(1);
            searched.push(body.query);
            return {
              hits: [],
              facets: null,
              total: SEARCH_TOTAL_NOT_COUNTED,
              nextCursor: null,
              paginationOutcome: SEARCH_PAGINATION_COMPLETE,
              pageReach: SEARCH_PAGE_REACH.REACHED,
              queryUsed: body.query,
              warnings: [],
              relaxedHitCount: 0,
            };
          },
        },
      },
      dependencies: {
        admitPublicRead: async ({ run }) => {
          slots += 1;
          return Result.ok({
            status: "leased",
            value: await run(new AbortController().signal),
          });
        },
        dispatchGatewayToolCall: async () => null,
      },
    });
    expect(slots).toBe(1);
    expect(searched.toSorted()).toEqual(queries.toSorted());
    expect(result.isError).not.toBe(true);
  });

  test("a cancelled corpus search is retryable and transient without a defect", async () => {
    const analytics = installRecordingAnalytics();
    const logs = installRecordingLogger();
    resetFailureObservationsForTesting();
    try {
      const context = createContext();
      const result = await handleMcpToolCall({
        toolName: "search_case_law",
        args: { country: "CZE", queries: ["smlouva"] },
        context: {
          ...context,
          testDependencies: {
            ...context.testDependencies,
            searchDecisionsHandler: async () => {
              expect(getPublicReadStatementTimeoutMs()).toBe(
                PUBLIC_READ_STATEMENT_TIMEOUT_MS.search,
              );
              throw new PublicLawStatementError({
                message: "Public-law statement failed",
                cause: Object.assign(new Error("private SQL diagnostics"), {
                  code: "57014",
                }),
              });
            },
          },
        },
      });
      expect(result.isError).toBe(true);
      expect(payloadOf(result)).toEqual({
        error: {
          code: "public_read_timeout",
          message: "Public read timed out. Please try again.",
          hint: "Retry with a narrower query or a smaller selection of public-law documents.",
          retryable: true,
        },
      });
      expect(analytics.exceptions()).toEqual([]);
      flushFailureObservations();
      expect(
        logs.records.filter(({ message }) => message === "failure.observed"),
      ).toMatchObject([
        {
          attributes: {
            "failure.grade": "transient",
            "failure.reason": "public_read_timeout",
          },
        },
      ]);
      expect(
        logs.records.some(
          ({ attributes }) => attributes?.["failure.grade"] === "defect",
        ),
      ).toBe(false);
      expect(JSON.stringify(logs.records)).not.toContain(
        "private SQL diagnostics",
      );
    } finally {
      resetFailureObservationsForTesting();
      logs.restore();
      analytics.restore();
    }
  });

  test("failed Results map cancels only inside the public-read budget", () => {
    const cancelled = new UnhandledException({
      cause: new PublicLawStatementError({
        message: "Public-law statement failed",
        cause: Object.assign(new Error("private SQL diagnostics"), {
          errno: "57014",
        }),
      }),
    });
    const within = runWithPublicReadStatementTimeout(
      { budgetMs: PUBLIC_READ_STATEMENT_TIMEOUT_MS.browse },
      () => internalFailureResult(cancelled, "mcp.response.failure"),
    );
    expect(payloadOf(serialized(within))).toMatchObject({
      error: { code: "public_read_timeout", retryable: true },
    });
    const outside = internalFailureResult(cancelled, "mcp.response.failure");
    expect(payloadOf(serialized(outside))).toMatchObject({
      error: { code: "internal_error" },
    });
  });
});
