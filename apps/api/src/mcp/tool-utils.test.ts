import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import { TOOL_OUTPUT_CONTRACT_DEGRADED_EVENT } from "@/api/lib/chat/tool-output-degrade";
import { runWithRequestId } from "@/api/lib/observability/request-context";
import { encodePaginationCursor } from "@/api/lib/pagination";
import type { McpRequestContext } from "@/api/mcp/context";
import type { InternalToolSuccess } from "@/api/mcp/tool-types";
import {
  buildCaseLawDecisionAppUrl,
  buildLegislationDocumentAppUrl,
  legalCitationLinkFields,
  buildCaseLawDecisionUrl,
  closestToolNames,
  didYouMean,
  ensureActiveWorkspace,
  ensureWorkspaceAccess,
  ISO_DATE_SCHEMA,
  isToolErrorResult,
  mapValibotIssues,
  notFoundResult,
  oauthScopeRecoveryHint,
  resolveWindowBounds,
  serializeToolResult,
  structuredErrorResult,
  toolDataResult,
  untypedToolDataResult,
  toPlainTextSnippet,
  validationErrorResult,
  windowTextByCursor,
} from "@/api/mcp/tool-utils";
import {
  defineMcpToolOutput,
  defineProjectedMcpToolOutput,
} from "@/api/mcp/valibot-tool-definition";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// FRONTEND_URL is "http://localhost:3000" (no trailing slash) from
// the test env preload; getAppBaseUrl() strips any trailing slash.
const BASE = "http://localhost:3000";
const WORKSPACE_ID = toSafeId<"workspace">("ws_1");
const DECISION_ID = "019dd47d-f507-7c84-b827-980af11b8980";
const COMPACT_DECISION_ID = "AZ3UffUHfIS4J5gK8RuJgA";

describe("MCP ISO date contract", () => {
  test("accepts ISO dates and rejects out-of-range date components", () => {
    expect(v.is(ISO_DATE_SCHEMA, "2026-08-23")).toBe(true);
    expect(v.is(ISO_DATE_SCHEMA, "2026-99-99")).toBe(false);
  });
});

const createWorkspaceGateContext = (
  status: "active" | "archived",
): {
  context: McpRequestContext;
  pinnedWorkspaceIds: string[];
} => {
  const pinnedWorkspaceIds: string[] = [];
  return {
    context: asTestRaw<McpRequestContext>({
      accessibleWorkspaceIdSet: new Set([WORKSPACE_ID]),
      accessibleWorkspaceStatusById: new Map([[WORKSPACE_ID, status]]),
      pinServerValidatedWorkspaceId: (
        validatedWorkspaceId: SafeId<"workspace">,
      ) => {
        pinnedWorkspaceIds.push(validatedWorkspaceId);
        return true;
      },
    }),
    pinnedWorkspaceIds,
  };
};

describe("MCP workspace authorization lifetime", () => {
  test("pins a workspace after the read access gate proves it", () => {
    const { context, pinnedWorkspaceIds } =
      createWorkspaceGateContext("archived");

    expect(ensureWorkspaceAccess({ context, workspaceId: "ws_1" })).toBe(
      WORKSPACE_ID,
    );
    expect(pinnedWorkspaceIds).toEqual(["ws_1"]);
  });

  test("pins only after the active-status gate succeeds", () => {
    const archived = createWorkspaceGateContext("archived");
    ensureActiveWorkspace({ context: archived.context, workspaceId: "ws_1" });
    expect(archived.pinnedWorkspaceIds).toEqual([]);

    const active = createWorkspaceGateContext("active");
    expect(
      ensureActiveWorkspace({ context: active.context, workspaceId: "ws_1" }),
    ).toBe(WORKSPACE_ID);
    expect(active.pinnedWorkspaceIds).toEqual(["ws_1"]);
  });
});

describe("buildCaseLawDecisionUrl", () => {
  test("prefixes the shared decision path with the app base URL", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "29 Cdo 123/2024",
        country: "CZE",
        court: "Nejvyšší soud",
        decisionId: DECISION_ID,
        language: null,
        languageAlternates: null,
        slug: "official-stable-slug",
      }),
    ).toBe(`${BASE}/law/cze/cases/nejvyssi-soud/official-stable-slug`);
  });

  test("links a decision without a stored slug by id, not by case number", () => {
    // A case-number slug is a segment `by-slug` cannot resolve.
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "23 Cdo 5068/2014",
        country: "CZE",
        court: "Nejvyšší soud",
        decisionId: DECISION_ID,
        language: null,
        languageAlternates: null,
        slug: null,
      }),
    ).toBe(
      `${BASE}/law/cze/cases/nejvyssi-soud/23-cdo-5068-2014--${COMPACT_DECISION_ID}`,
    );
  });
});

describe("buildCaseLawDecisionAppUrl gate", () => {
  let restoreRuntimeMode: () => void = () => undefined;
  let previousFeaturePublicLaw: boolean;

  const input = {
    caseNumber: "1/24",
    country: "CZE",
    court: "NS",
    decisionId: DECISION_ID,
    language: null,
    languageAlternates: null,
    slug: "s",
  };

  beforeEach(() => {
    previousFeaturePublicLaw = env.FEATURE_PUBLIC_LAW;
  });

  afterEach(() => {
    restoreRuntimeMode();
    env.FEATURE_PUBLIC_LAW = previousFeaturePublicLaw;
  });

  test("returns null when public law is disabled outside local development", () => {
    restoreRuntimeMode = setRuntimeModeForTesting({
      mode: RUNTIME_MODE.strict,
    });
    env.FEATURE_PUBLIC_LAW = false;

    expect(buildCaseLawDecisionAppUrl(input)).toBeNull();
  });

  test("builds the URL when the public-law feature flag is on", () => {
    restoreRuntimeMode = setRuntimeModeForTesting({
      mode: RUNTIME_MODE.strict,
    });
    env.FEATURE_PUBLIC_LAW = true;

    expect(buildCaseLawDecisionAppUrl(input)).toBe(
      `${BASE}/law/cze/cases/ns/s`,
    );
  });

  test("builds the URL in local development regardless of the feature flag", () => {
    restoreRuntimeMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.open });
    env.FEATURE_PUBLIC_LAW = false;

    expect(buildCaseLawDecisionAppUrl(input)).toBe(
      `${BASE}/law/cze/cases/ns/s`,
    );
  });
});

const expectWindow = (value: ReturnType<typeof windowTextByCursor>) => {
  if (isToolErrorResult(value)) {
    throw new Error("expected a text window, got a tool error");
  }
  return value;
};

describe("windowTextByCursor", () => {
  test("returns the whole text with no nextCursor when it fits one window", () => {
    const window = expectWindow(
      windowTextByCursor({ cursor: undefined, maxChars: 100, text: "hello" }),
    );

    expect(window.text).toBe("hello");
    expect(window.charCount).toBe(5);
    expect(window.truncated).toBe(false);
    expect(window.nextCursor).toBeNull();
  });

  test("pages through long text without dropping or duplicating characters", () => {
    const text = "abcdefghijklmnopqrstuvwxyz0123456789";
    const maxChars = 8;

    let cursor: string | undefined;
    let assembled = "";
    let pages = 0;
    do {
      const window = expectWindow(
        windowTextByCursor({ cursor, maxChars, text }),
      );
      expect(window.text.length).toBeLessThanOrEqual(maxChars);
      expect(window.charCount).toBe(text.length);
      assembled += window.text;
      cursor = window.nextCursor ?? undefined;
      pages += 1;
      if (pages > 100) {
        throw new Error("pagination did not terminate");
      }
    } while (cursor !== undefined);

    expect(assembled).toBe(text);
    expect(pages).toBe(Math.ceil(text.length / maxChars));
  });

  test("Unicode text windows reassemble without splitting code points at any small budget", () => {
    const text = "😀A𠮷\n👩🏽‍⚖️éZ";
    for (const maxChars of [1, 2, 3, 4, 5, 6]) {
      let cursor: string | undefined;
      const parts: string[] = [];
      do {
        const window = expectWindow(
          windowTextByCursor({ cursor, maxChars, text }),
        );
        expect(window.text).not.toMatch(/[\uD800-\uDFFF]/u);
        expect(window.text.match(/./gsu)?.length).toBeLessThanOrEqual(maxChars);
        expect(window.text.length).toBeGreaterThan(0);
        parts.push(window.text);
        expect(parts.length).toBeLessThanOrEqual(text.length);
        cursor = window.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(parts.join("")).toBe(text);
    }
  });

  test("marks truncated and emits a nextCursor on the first of several windows", () => {
    const window = expectWindow(
      windowTextByCursor({ cursor: undefined, maxChars: 4, text: "abcdefgh" }),
    );

    expect(window.text).toBe("abcd");
    expect(window.truncated).toBe(true);
    expect(window.nextCursor).not.toBeNull();
  });

  test("rejects a malformed cursor", () => {
    const result = windowTextByCursor({
      cursor: "not-a-real-cursor",
      maxChars: 8,
      text: "abcdefgh",
    });

    expect(isToolErrorResult(result)).toBe(true);
  });

  test("clamps an offset past the end to an empty final window", () => {
    const result = expectWindow(
      windowTextByCursor({
        cursor: encodePaginationCursor([999]),
        maxChars: 4,
        text: "abcd",
      }),
    );
    expect(result.text).toBe("");
    expect(result.nextCursor).toBeNull();
    expect(result.truncated).toBe(false);
  });
});

const errorText = (result: ReturnType<typeof structuredErrorResult>) => {
  const item = serializeToolResult(result).content.at(0);
  if (!item || item.type !== "text") {
    throw new Error("expected a text error content");
  }
  return item.text;
};

describe("serializeToolResult", () => {
  test("rejects an undefined success payload at the MCP boundary", () => {
    expect(() =>
      serializeToolResult({ status: "success", data: undefined }),
    ).toThrow("Internal tool success data must be JSON-serializable");
  });

  test("mirrors an object payload into structuredContent, text unchanged", () => {
    const data = { matterId: "ws_1", updated: true };
    const result = serializeToolResult({ status: "success", data });

    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(data) },
    ]);
    expect(result.structuredContent).toEqual(data);
  });

  test("derives the one text block from the validated structured object", () => {
    // Handler key order and an undeclared key differ from the contract; the
    // text still says exactly what structuredContent says.
    const contract = defineMcpToolOutput(
      v.object({ entityId: v.string(), nextStep: v.string() }),
    );
    const result = serializeToolResult(
      untypedToolDataResult({
        nextStep: "Choose a file.",
        undeclared: true,
        entityId: "doc_1",
      }),
      contract,
    );

    expect(result.structuredContent).toEqual({
      entityId: "doc_1",
      nextStep: "Choose a file.",
    });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(result.structuredContent) },
    ]);
  });

  test("has no prose side channel beside the result data", () => {
    // Guidance the model needs is a field of the output contract: a host that
    // shows structuredContent never shows extra text blocks.
    // @ts-expect-error -- a success is its data; there is no presentation text.
    toolDataResult({ entityId: "doc_1" }, { primaryText: "Choose a file." });
    const smuggled: InternalToolSuccess = {
      status: "success",
      data: { entityId: "doc_1" },
      // @ts-expect-error -- a success carries no `mcp` presentation options.
      mcp: { additionalText: ["Choose a file."] },
    };

    expect(serializeToolResult(smuggled).content).toEqual([
      { type: "text", text: JSON.stringify({ entityId: "doc_1" }) },
    ]);
  });

  test("projects arbitrary handler data into a stable structured envelope", () => {
    const contract = defineProjectedMcpToolOutput(
      v.strictObject({ result: v.unknown() }),
      (result) => ({ result }),
    );
    const result = serializeToolResult(
      { status: "success", data: [1, 2] },
      contract,
    );

    expect(result.structuredContent).toEqual({ result: [1, 2] });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ result: [1, 2] }) },
    ]);
  });

  test("fails closed when projected content violates the advertised schema", () => {
    const contract = defineMcpToolOutput(
      v.strictObject({ entityId: v.string() }),
    );

    expect(() =>
      serializeToolResult(
        { status: "success", data: { entityId: 42 } },
        contract,
      ),
    ).toThrow("MCP tool output violated its advertised contract");
  });

  describe("undeclared output keys", () => {
    let analytics: RecordingAnalytics;
    let logs: RecordingLogger;

    beforeEach(() => {
      analytics = installRecordingAnalytics();
      logs = installRecordingLogger();
    });

    afterEach(() => {
      analytics.restore();
      logs.restore();
    });

    const degradeLogs = () =>
      logs
        .at("ERROR")
        .filter(
          ({ message }) => message === TOOL_OUTPUT_CONTRACT_DEGRADED_EVENT,
        )
        .map(({ attributes }) => attributes);

    const contract = defineMcpToolOutput(
      v.strictObject({
        entityId: v.string(),
        hits: v.array(
          v.strictObject({
            match: v.variant("kind", [
              v.strictObject({ kind: v.literal("exact"), score: v.number() }),
              v.strictObject({
                kind: v.literal("fuzzy"),
                distance: v.number(),
              }),
            ]),
            title: v.string(),
          }),
        ),
      }),
    );

    test("are stripped at every depth, the result returned and the defect logged", () => {
      const result = serializeToolResult(
        untypedToolDataResult({
          entityId: "doc_1",
          hits: [
            {
              match: { kind: "exact", score: 1, rawScore: "privileged-1" },
              title: "A",
            },
            {
              match: { distance: 2, kind: "fuzzy" },
              snippetHtml: "privileged-2",
              title: "B",
            },
          ],
          internalCursor: "privileged-3",
        }),
        contract,
        "search_test",
      );

      const expected = {
        entityId: "doc_1",
        hits: [
          { match: { kind: "exact", score: 1 }, title: "A" },
          { match: { distance: 2, kind: "fuzzy" }, title: "B" },
        ],
      };
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(expected);
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify(result.structuredContent) },
      ]);
      expect(degradeLogs()).toEqual([
        {
          defect: "undeclared_fields",
          paths: "hits[].match.rawScore, hits[].snippetHtml, internalCursor",
          source: "mcp",
          tool: "search_test",
        },
      ]);
      expect(
        analytics.exceptions().map((event) => event.properties),
      ).toMatchObject([
        {
          defect: "undeclared_fields",
          "error.class": "ToolOutputContractDegradedError",
          toolName: "search_test",
        },
      ]);
      expect(JSON.stringify([analytics.events, logs.records])).not.toContain(
        "privileged",
      );
    });

    test("never excuse a missing or invalid declared field", () => {
      for (const data of [
        // Missing declared field.
        { hits: [] },
        // Invalid declared field.
        { entityId: 42, hits: [] },
        // Invalid declared field inside a union branch, beside an extra key.
        {
          entityId: "doc_1",
          hits: [{ match: { kind: "exact", score: "1" }, title: "A", x: 1 }],
        },
        // An extra key beside a missing one.
        { extra: true, hits: [] },
      ]) {
        expect(() =>
          serializeToolResult(
            untypedToolDataResult(data),
            contract,
            "search_test",
          ),
        ).toThrow("MCP tool output violated its advertised contract");
      }
      expect(degradeLogs()).toEqual([]);
    });

    test("a contract-clean output reports nothing", () => {
      const data = { entityId: "doc_1", hits: [] };
      const result = serializeToolResult(
        untypedToolDataResult(data),
        contract,
        "search_test",
      );

      expect(result.structuredContent).toEqual(data);
      expect(degradeLogs()).toEqual([]);
      expect(analytics.exceptions()).toEqual([]);
    });
  });

  test("omits structuredContent for a non-object payload", () => {
    const result = serializeToolResult({ status: "success", data: [1, 2] });

    expect(result.content).toEqual([{ type: "text", text: "[1,2]" }]);
    expect(result.structuredContent).toBeUndefined();
  });

  test("omits structuredContent for an error envelope", () => {
    const result = serializeToolResult(
      structuredErrorResult({ code: "not_found", message: "gone" }),
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });
});

describe("toPlainTextSnippet", () => {
  test("strips highlight markup and decodes entities from a search headline", () => {
    expect(
      toPlainTextSnippet(
        "&quot;<mark>smlouva</mark> (1)(4).docx&quot; &amp; annexes",
      ),
    ).toBe('"smlouva (1)(4).docx" & annexes');
  });

  test("keeps an escaped literal tag as text", () => {
    expect(toPlainTextSnippet("&lt;mark&gt; and &amp;lt; stay literal")).toBe(
      "<mark> and &lt; stay literal",
    );
  });

  test("passes a missing headline through", () => {
    expect(toPlainTextSnippet(null)).toBeNull();
  });
});

describe("oauthScopeRecoveryHint", () => {
  test("preserves granted scopes, adds every required scope, and removes duplicates", () => {
    expect(
      oauthScopeRecoveryHint({
        grantedScopes: ["openid", "offline_access", "stella:documents_write"],
        missingScope: "stella:templates",
        requiredScopes: ["stella:documents_write", "stella:templates"],
      }),
    ).toBe(
      "Grant the 'stella:templates' scope by re-running OAuth consent (CLI: 'stella auth login --scopes openid,offline_access,stella:documents_write,stella:templates'), then retry.",
    );
  });
});

describe("structuredErrorResult", () => {
  test("serializes a minimal envelope and marks isError", () => {
    const result = structuredErrorResult({
      code: "validation_error",
      message: "bad arg",
    });

    expect(result.status).toBe("error");
    expect(errorText(result)).toBe(
      JSON.stringify({
        error: { code: "validation_error", message: "bad arg" },
      }),
    );
  });

  test("includes hint and retryable when provided", () => {
    const result = structuredErrorResult({
      code: "rate_limited",
      message: "slow down",
      hint: "retry after the window",
      retryable: true,
      contactUrl: "https://example.test/contact",
    });

    expect(JSON.parse(errorText(result))).toEqual({
      error: {
        code: "rate_limited",
        message: "slow down",
        hint: "retry after the window",
        retryable: true,
        contactUrl: "https://example.test/contact",
      },
    });
  });

  test("omits undefined hint and retryable keys entirely", () => {
    const text = errorText(
      structuredErrorResult({ code: "internal_error", message: "boom" }),
    );

    expect(text).not.toContain("hint");
    expect(text).not.toContain("retryable");
    expect(text).not.toContain("contactUrl");
  });

  test("includes issues under error.issues when non-empty", () => {
    const result = structuredErrorResult({
      code: "validation_error",
      message: "bad arg",
      issues: [{ path: "matter_id", message: "Required" }],
    });

    expect(JSON.parse(errorText(result))).toEqual({
      error: {
        code: "validation_error",
        message: "bad arg",
        issues: [{ path: "matter_id", message: "Required" }],
      },
    });
  });

  test("omits an empty issues array so the shape stays minimal", () => {
    const text = errorText(
      structuredErrorResult({
        code: "validation_error",
        message: "bad arg",
        issues: [],
      }),
    );

    expect(text).not.toContain("issues");
  });

  test("carries the active request receipt under error.requestId", () => {
    const parsed = runWithRequestId("req_envelope", () =>
      JSON.parse(
        errorText(
          structuredErrorResult({ code: "not_found", message: "gone" }),
        ),
      ),
    );

    expect(parsed).toEqual({
      error: { code: "not_found", message: "gone", requestId: "req_envelope" },
    });
  });

  test("omits requestId when no request is active", () => {
    const text = errorText(
      structuredErrorResult({ code: "not_found", message: "gone" }),
    );

    expect(text).not.toContain("requestId");
  });
});

describe("mapValibotIssues", () => {
  const schema = v.strictObject({
    matter_id: v.pipe(v.string(), v.minLength(1)),
    limit: v.optional(v.pipe(v.number(), v.integer())),
  });

  test("maps a field issue to its dot-path", () => {
    const parsed = v.safeParse(schema, { matter_id: 123 });
    if (parsed.success) {
      throw new Error("expected a validation failure");
    }

    const issues = mapValibotIssues(parsed.issues);
    expect(issues.at(0)?.path).toBe("matter_id");
    expect(typeof issues.at(0)?.message).toBe("string");
  });

  test("falls back to an empty path for a root issue", () => {
    // A top-level type mismatch has no field, so `getDotPath` yields no path.
    const parsed = v.safeParse(v.pipe(v.string(), v.minLength(1)), 123);
    if (parsed.success) {
      throw new Error("expected a validation failure");
    }

    expect(mapValibotIssues(parsed.issues).at(0)?.path).toBe("");
  });
});

describe("validationErrorResult", () => {
  test("emits a validation_error envelope with mapped issues", () => {
    const schema = v.strictObject({ name: v.pipe(v.string(), v.minLength(1)) });
    const parsed = v.safeParse(schema, {});
    if (parsed.success) {
      throw new Error("expected a validation failure");
    }

    const result = validationErrorResult(parsed.issues);

    expect(result.status).toBe("error");
    const payload = JSON.parse(errorText(result));
    expect(payload.error.code).toBe("validation_error");
    expect(payload.error.message).toBe(parsed.issues.at(0)?.message);
    expect(payload.error.issues).toEqual([
      { path: "name", message: expect.any(String) },
    ]);
  });
});

describe("notFoundResult", () => {
  test("wraps a not_found code with an optional hint", () => {
    expect(
      JSON.parse(errorText(notFoundResult("gone", "check the id"))),
    ).toEqual({
      error: { code: "not_found", message: "gone", hint: "check the id" },
    });
  });

  test("omits the hint when not supplied", () => {
    expect(JSON.parse(errorText(notFoundResult("gone")))).toEqual({
      error: { code: "not_found", message: "gone" },
    });
  });
});

describe("closestToolNames", () => {
  const candidates = [
    "list_matters",
    "save_matter",
    "delete_matter",
    "search_case_law",
  ];

  test("ranks the nearest name first for a typo", () => {
    expect(closestToolNames("list_mater", candidates).at(0)).toBe(
      "list_matters",
    );
  });

  test("matches a name whose words were regrouped", () => {
    expect(
      closestToolNames("widgets.delete-part", [
        "widgets.bolts.delete",
        "widgets.parts.get",
        "widgets.parts.delete",
      ]).at(0),
    ).toBe("widgets.parts.delete");
  });

  test("returns nothing for an unrelated miss", () => {
    expect(closestToolNames("zzzzzzzzzzzz", candidates)).toEqual([]);
  });

  test("caps the suggestions at the requested limit", () => {
    expect(
      closestToolNames("matter", candidates, 2).length,
    ).toBeLessThanOrEqual(2);
  });

  test("matches a name spelled as a chat script function or in another case", () => {
    for (const spelling of [
      "external_list_matters",
      "listMatters",
      "LIST_MATTERS",
      "list-matters",
    ]) {
      expect(closestToolNames(spelling, candidates).at(0)).toBe("list_matters");
    }
  });
});

describe("didYouMean", () => {
  test("offers one name, several, or nothing", () => {
    expect(didYouMean(["`a`"])).toBe("Did you mean `a`?");
    expect(didYouMean(["`a`", "`b`"])).toBe("Did you mean one of `a`, `b`?");
    expect(didYouMean([])).toBe("");
  });
});

describe("resolveWindowBounds", () => {
  test("returns a full window with no next offset when everything fits", () => {
    expect(resolveWindowBounds(5, 0, 50)).toEqual({
      start: 0,
      end: 5,
      nextOffset: null,
    });
  });

  test("emits the resume offset when the stream has more", () => {
    expect(resolveWindowBounds(10, 0, 4)).toEqual({
      start: 0,
      end: 4,
      nextOffset: 4,
    });
  });

  test("clamps an offset past the end to an empty terminal window", () => {
    expect(resolveWindowBounds(5, 99, 4)).toEqual({
      start: 5,
      end: 5,
      nextOffset: null,
    });
  });
});

describe("primary legal citation links", () => {
  for (const path of [
    "/law/cze/statutes/89-2012-sb",
    "/law/cze/statutes/89-2012-sb/v/2014-01-01#par_1729",
    "/law/cze/cases/ns/1-24",
  ]) {
    test(`held ${path} keeps its publisher as a secondary source`, () => {
      const sourceUrl = `https://publisher.example/${DECISION_ID}`;
      const appUrl = `${BASE}${path}`;
      expect(legalCitationLinkFields({ appUrl, sourceUrl })).toEqual({
        appUrl,
        url: appUrl,
        source_url: sourceUrl,
      });
    });
    test(`unserved ${path} falls back to the publisher`, () => {
      const sourceUrl = `https://publisher.example/${DECISION_ID}`;
      expect(legalCitationLinkFields({ appUrl: null, sourceUrl })).toEqual({
        appUrl: null,
        url: sourceUrl,
      });
    });
  }
  test("a held provision links its consolidation and exact anchor", () => {
    const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.open });
    try {
      expect(
        buildLegislationDocumentAppUrl({
          country: "CZE",
          documentId: DECISION_ID,
          eli: "/eli/cz/sb/2012/89",
          slug: "89-2012-sb",
          version: "2014-01-01",
          anchor: "par_1729",
        }),
      ).toBe(`${BASE}/law/cze/statutes/89-2012-sb/v/2014-01-01#par_1729`);
    } finally {
      restore();
    }
  });
});
