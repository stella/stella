import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { env } from "@/api/env";
import { runWithRequestId } from "@/api/lib/observability/request-context";
import { encodePaginationCursor } from "@/api/lib/pagination";
import {
  buildCaseLawDecisionAppUrl,
  buildCaseLawDecisionUrl,
  closestToolNames,
  isToolErrorResult,
  mapValibotIssues,
  notFoundResult,
  parseOptionalCursor,
  resolveWindowBounds,
  slugifyCaseLawPathSegment,
  structuredErrorResult,
  validationErrorResult,
  windowTextByCursor,
} from "@/api/mcp/tool-utils";

// FRONTEND_URL is "http://localhost:3000" (no trailing slash) from
// the test env preload; getAppBaseUrl() strips any trailing slash.
const BASE = "http://localhost:3000";

describe("slugifyCaseLawPathSegment", () => {
  test("lowercases, strips diacritics, and collapses runs to single hyphens", () => {
    expect(slugifyCaseLawPathSegment("Nejvyšší soud")).toBe("nejvyssi-soud");
  });

  test("collapses non-alphanumerics and trims leading/trailing hyphens", () => {
    expect(slugifyCaseLawPathSegment("  29 Cdo 123/2024  ")).toBe(
      "29-cdo-123-2024",
    );
  });

  test("falls back to 'unknown' when nothing alphanumeric remains", () => {
    expect(slugifyCaseLawPathSegment("///")).toBe("unknown");
    expect(slugifyCaseLawPathSegment("")).toBe("unknown");
  });
});

describe("buildCaseLawDecisionUrl", () => {
  test("uses a stored slug verbatim (re-slugified) over the case number", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "29 Cdo 123/2024",
        country: "CZE",
        court: "Nejvyšší soud",
        slug: "official-stable-slug",
      }),
    ).toBe(`${BASE}/law/cze/cases/nejvyssi-soud/official-stable-slug`);
  });

  test("derives the decision slug from the case number when no stored slug", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "29 Cdo 123/2024",
        country: "CZE",
        court: "Nejvyšší soud",
      }),
    ).toBe(`${BASE}/law/cze/cases/nejvyssi-soud/29-cdo-123-2024`);
  });

  test("lowercases the country and slugifies the court segment", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "C-123/24",
        country: "DEU",
        court: "Bundesgerichtshof",
        slug: "x",
      }),
    ).toBe(`${BASE}/law/deu/cases/bundesgerichtshof/x`);
  });

  test("uses the unknown-court segment for a blank court", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "1/24",
        country: "CZE",
        court: "   ",
        slug: "s",
      }),
    ).toBe(`${BASE}/law/cze/cases/unknown-court/s`);
  });

  test("inserts the language segment only when more than one language alternate exists", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "1/24",
        country: "CZE",
        court: "NS",
        slug: "s",
        language: "cs",
        languageAlternateCount: 2,
      }),
    ).toBe(`${BASE}/law/cze/cases/ns/cs/s`);
  });

  test("omits the language segment when only one alternate exists", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "1/24",
        country: "CZE",
        court: "NS",
        slug: "s",
        language: "cs",
        languageAlternateCount: 1,
      }),
    ).toBe(`${BASE}/law/cze/cases/ns/s`);
  });

  test("omits the language segment when the language code is not a valid BCP-47-ish tag", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "1/24",
        country: "CZE",
        court: "NS",
        slug: "s",
        language: "not a language",
        languageAlternateCount: 5,
      }),
    ).toBe(`${BASE}/law/cze/cases/ns/s`);
  });

  test("normalizes underscores in the language tag to hyphens", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "1/24",
        country: "CZE",
        court: "NS",
        slug: "s",
        language: "CS_CZ",
        languageAlternateCount: 2,
      }),
    ).toBe(`${BASE}/law/cze/cases/ns/cs-cz/s`);
  });

  test("counts distinct normalized language alternates when no explicit count is given", () => {
    const url = buildCaseLawDecisionUrl({
      caseNumber: "1/24",
      country: "CZE",
      court: "NS",
      slug: "s",
      language: "cs",
      languageAlternates: [
        { language: "cs" },
        { language: "CS" }, // dedupes with "cs" after normalization
        { language: "en" },
        { language: "??" }, // invalid -> ignored
        "not-an-object", // malformed -> ignored
      ],
    });

    // Two distinct valid languages (cs, en) > 1 -> language segment present.
    expect(url).toBe(`${BASE}/law/cze/cases/ns/cs/s`);
  });

  test("omits the language segment when distinct alternates do not exceed one", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "1/24",
        country: "CZE",
        court: "NS",
        slug: "s",
        language: "cs",
        languageAlternates: [{ language: "cs" }, { language: "CS" }],
      }),
    ).toBe(`${BASE}/law/cze/cases/ns/s`);
  });

  test("prefers the explicit alternate count over the alternates array", () => {
    expect(
      buildCaseLawDecisionUrl({
        caseNumber: "1/24",
        country: "CZE",
        court: "NS",
        slug: "s",
        language: "cs",
        languageAlternateCount: 1,
        languageAlternates: [{ language: "cs" }, { language: "en" }],
      }),
    ).toBe(`${BASE}/law/cze/cases/ns/s`);
  });
});

describe("buildCaseLawDecisionAppUrl gate", () => {
  let previousIsDev: boolean;
  let previousFeaturePublicLaw: boolean;

  const input = {
    caseNumber: "1/24",
    country: "CZE",
    court: "NS",
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
  const item = result.content.at(0);
  if (!item || item.type !== "text") {
    throw new Error("expected a text error content");
  }
  return item.text;
};

describe("structuredErrorResult", () => {
  test("serializes a minimal envelope and marks isError", () => {
    const result = structuredErrorResult({
      code: "validation_error",
      message: "bad arg",
    });

    expect(result.isError).toBe(true);
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

    const result = validationErrorResult({
      issues: parsed.issues,
      message: "name is required",
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(errorText(result));
    expect(payload.error.code).toBe("validation_error");
    expect(payload.error.message).toBe("name is required");
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
