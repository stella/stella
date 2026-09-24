import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { env } from "@/api/env";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import { runWithRequestId } from "@/api/lib/observability/request-context";
import { encodePaginationCursor } from "@/api/lib/pagination";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  buildCaseLawDecisionAppUrl,
  buildCaseLawDecisionUrl,
  closestToolNames,
  ensureActiveWorkspace,
  ensureWorkspaceAccess,
  ISO_DATE_SCHEMA,
  isToolErrorResult,
  mapValibotIssues,
  notFoundResult,
  oauthScopeRecoveryHint,
  parseOptionalCursor,
  resolveWindowBounds,
  serializeToolResult,
  structuredErrorResult,
  toPlainTextSnippet,
  validationErrorResult,
  windowTextByCursor,
} from "@/api/mcp/tool-utils";
import {
  defineMcpToolOutput,
  defineProjectedMcpToolOutput,
} from "@/api/mcp/valibot-tool-definition";
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
  let previousIsDev: boolean;
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
    previousIsDev = env.isDev;
    previousFeaturePublicLaw = env.FEATURE_PUBLIC_LAW;
  });

  afterEach(() => {
    env.isDev = previousIsDev;
    env.FEATURE_PUBLIC_LAW = previousFeaturePublicLaw;
  });

  test("returns null when public law is disabled and not in dev", () => {
    env.isDev = false;
    env.FEATURE_PUBLIC_LAW = false;

    expect(buildCaseLawDecisionAppUrl(input)).toBeNull();
  });

  test("builds the URL when the public-law feature flag is on", () => {
    env.isDev = false;
    env.FEATURE_PUBLIC_LAW = true;

    expect(buildCaseLawDecisionAppUrl(input)).toBe(
      `${BASE}/law/cze/cases/ns/s`,
    );
  });

  test("builds the URL in dev regardless of the feature flag", () => {
    env.isDev = true;
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

describe("parseOptionalCursor", () => {
  test("returns undefined when the cursor arg is absent", () => {
    expect(parseOptionalCursor({ args: {}, key: "cursor" })).toBeUndefined();
  });

  test("passes a well-formed cursor through unchanged", () => {
    const cursor = "eyJhIjoxfQ";
    expect(parseOptionalCursor({ args: { cursor }, key: "cursor" })).toBe(
      cursor,
    );
  });

  test("rejects a non-string cursor", () => {
    const result = parseOptionalCursor({ args: { cursor: 42 }, key: "cursor" });
    expect(isToolErrorResult(result)).toBe(true);
  });

  test("rejects an over-long cursor", () => {
    const result = parseOptionalCursor({
      args: { cursor: "x".repeat(513) },
      key: "cursor",
    });
    expect(isToolErrorResult(result)).toBe(true);
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

  test("keeps prose text while deriving structured content from its contract", () => {
    const data = { entityId: "doc_1" };
    const contract = defineMcpToolOutput(
      v.strictObject({ entityId: v.string() }),
    );
    const result = serializeToolResult(
      {
        status: "success",
        data,
        mcp: { primaryText: "Choose a file." },
      },
      contract,
    );

    expect(result.content).toEqual([{ type: "text", text: "Choose a file." }]);
    expect(result.structuredContent).toEqual(data);
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

    expect(result.content).toEqual([{ type: "text", text: "[1,2]" }]);
    expect(result.structuredContent).toEqual({ result: [1, 2] });
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
    });

    expect(JSON.parse(errorText(result))).toEqual({
      error: {
        code: "rate_limited",
        message: "slow down",
        hint: "retry after the window",
        retryable: true,
      },
    });
  });

  test("omits undefined hint and retryable keys entirely", () => {
    const text = errorText(
      structuredErrorResult({ code: "internal_error", message: "boom" }),
    );

    expect(text).not.toContain("hint");
    expect(text).not.toContain("retryable");
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
