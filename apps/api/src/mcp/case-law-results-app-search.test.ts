import { SQL } from "bun";
import { describe, expect, test } from "bun:test";

import {
  filterDefaults,
  originalSearchQuery,
  searchSubmitInput,
} from "@stll/mcp-apps/case-law-results/model";
import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { HttpStatusResponse } from "@/api/http/status";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const state = createTestState({ file: import.meta.path, config: env });

/**
 * Runs a search through the real dispatcher and reports whether it got past
 * input validation: the search or provision lookup is reached only then.
 */
const dispatchSearch = async (args: Record<string, unknown>) => {
  state.setConfig("FEATURE_PUBLIC_LAW", true);
  const { safeDb, scopedDb } = createScopedDbMock({
    query: { organizationSettings: { findFirst: async () => undefined } },
  });
  const probe = { reached: false };
  const context = authorizedMcpContextForTest({
    accessibleWorkspaceIds: [],
    accessibleWorkspaceIdSet: new Set(),
    accessibleWorkspaceStatusById: new Map(),
    accessibleWorkspaces: [],
    grantedScopes: [],
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    recordAuditEvent: asTestRaw(async () => undefined),
    safeDb,
    scopedDb,
    thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
    testDependencies: {
      readCaseLawCourtNames: async () => [],
      readProvisionWorkLinked: async () => {
        probe.reached = true;
        throw new SQL.PostgresError("provision lookup reached", {
          code: "ERR_POSTGRES_SERVER_ERROR",
          errno: "57014",
          detail: "",
          hint: "",
          severity: "ERROR",
        });
      },
      searchDecisionsHandler: asTestRaw(async () => {
        probe.reached = true;
        return new HttpStatusResponse(503, {
          code: "public_read_timeout",
          message: "search reached",
        });
      }),
    },
    userId: toSafeId<"user">("user_1"),
    userEmail: "standard@example.test",
  });
  const result = await handleMcpToolCall({
    args,
    context,
    mode: "default",
    toolName: "search_case_law",
  });
  const text = result.content.at(0);
  return {
    reached: probe.reached,
    refusal: text?.type === "text" && !probe.reached ? text.text : undefined,
  };
};

// Calls the model makes, each the input the results app opens with.
const MODEL_CALLS: Record<string, unknown>[] = [
  { queries: ["2Obdo/39/2010"], country: "SVK" },
  {
    queries: ["náhrada škody", "odškodnění"],
    country: "CZ",
    court: "Nejvyšší soud",
    date_from: "2020",
    limit: 10,
    sort: "newest",
    facets: ["court"],
  },
  {
    queries: ["výpověď"],
    country: "Slovakia",
    courts: ["Najvyšší súd", "Krajský súd v Bratislave"],
    date_to: "2024-12-31",
    unknown_model_key: true,
  },
  { country: "CZE", provision: "§ 2910 OZ" },
];

// What the user can leave in the form before pressing search or filter.
const SEARCH_BOXES = [
  { box: "original", query: (original: string) => original },
  { box: "edited", query: () => "pracovní úraz" },
  { box: "empty", query: () => "" },
  { box: "blank", query: () => "   " },
] as const;
const COURT_PICKS = [
  { type: "all" },
  { type: "courts", names: ["Nejvyšší soud", "Ústavní soud"] },
] as const;
const DATE_RANGES = [
  { from: "", to: "" },
  { from: "2019-01-01", to: "2023-06-30" },
] as const;

const formSubmissions = () =>
  MODEL_CALLS.flatMap((input) => {
    const defaults = filterDefaults(input);
    if (defaults.status !== "ready") {
      throw new Error(`Model call opens no form: ${JSON.stringify(input)}`);
    }
    const originalQuery = originalSearchQuery(input);
    return SEARCH_BOXES.flatMap(({ box, query: fill }) =>
      COURT_PICKS.flatMap((court) =>
        DATE_RANGES.flatMap((dates) =>
          [defaults.country, "CZE"].map((country) => {
            const query = fill(originalQuery);
            return {
              input,
              box,
              query,
              submission: searchSubmitInput({
                input,
                query,
                originalQuery,
                country,
                court,
                ...dates,
              }),
            };
          }),
        ),
      ),
    );
  });

describe("case-law results app searches", () => {
  test("every search the form submits passes the tool's input validation", async () => {
    const submissions = formSubmissions();
    const sent = submissions.flatMap(({ submission }) =>
      submission.type === "search" ? [submission.input] : [],
    );
    expect(sent.length).toBeGreaterThan(0);
    for (const args of sent) {
      const { reached, refusal } = await dispatchSearch(args);
      expect(refusal, JSON.stringify(args)).toBeUndefined();
      expect(reached, JSON.stringify(args)).toBe(true);
    }
  });

  test("an empty search box submits nothing unless a provision carries the search", () => {
    for (const { input, box, query, submission } of formSubmissions()) {
      const empty = query.trim() === "";
      const carried = input["provision"] !== undefined;
      expect(submission.type, `${JSON.stringify(input)} box=${box}`).toBe(
        empty && !carried ? "needs_query" : "search",
      );
      if (submission.type === "search" && empty) {
        expect(submission.input).not.toHaveProperty("queries");
      }
    }
  });

  test("the server refuses an empty query, which is why the form never sends one", async () => {
    const { reached, refusal } = await dispatchSearch({
      queries: [""],
      country: "SVK",
    });
    expect(reached).toBe(false);
    expect(JSON.parse(refusal ?? "{}")).toMatchObject({
      error: {
        code: "validation_error",
        issues: [{ path: "queries.0" }],
      },
    });
  });
});
