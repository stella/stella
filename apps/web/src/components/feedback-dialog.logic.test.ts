import { describe, expect, test } from "bun:test";

import { FEEDBACK_AREAS, FEEDBACK_KINDS } from "@stll/api-contract/feedback";
import type { FeedbackArea } from "@stll/api-contract/feedback";

import {
  FEEDBACK_AREA_LABEL_KEYS,
  FEEDBACK_FALLBACK_AREA,
  FEEDBACK_KIND_LABEL_KEYS,
  ROUTE_AREA_PATTERNS,
  resolveFeedbackArea,
} from "@/components/feedback-dialog.logic";

/** Areas no web route can produce. Every other area must be reachable from a
 *  route pattern, so a new contract area forces a decision here instead of
 *  quietly collapsing into the fallback. */
const AREAS_WITHOUT_A_WEB_ROUTE = new Set<FeedbackArea>([
  FEEDBACK_FALLBACK_AREA,
]);

describe("feedback area for the current route", () => {
  test.each([
    ["/workspaces", "matters"],
    ["/workspaces/ws_7f2/lists", "matters"],
    ["/workspaces/ws_7f2/view_3/document", "documents"],
    ["/workspaces/ws_7f2/invoices", "billing"],
    ["/workspaces/ws_7f2/invoices/inv_9", "billing"],
    ["/workspaces/ws_7f2/expenses", "billing"],
    ["/workspaces/ws_7f2/timesheets", "billing"],
    ["/workspaces/ws_7f2/reports/utilization", "billing"],
    ["/chat/thr_12", "chat"],
    ["/contacts", "contacts"],
    ["/inbox", "tasks"],
    ["/knowledge/templates", "templates"],
    ["/knowledge/mcp", "mcp_cli"],
    ["/law/statutes/cz/89-2012", "legislation"],
    ["/law/cases", "case_law"],
    ["/law/cz/cases/abc", "case_law"],
    ["/law/cz/statutes/89-2012", "legislation"],
    ["/settings/organization/members", "web_app"],
    ["/settings/account/desktop", "desktop"],
    ["/tools/anonymize", "web_app"],
    ["/onboarding", "web_app"],
    ["/mcp/oauth-callback", "mcp_cli"],
  ] as const satisfies readonly (readonly [string, FeedbackArea])[])(
    "routes %s to %s",
    (pathname, area) => {
      expect(resolveFeedbackArea(pathname)).toBe(area);
    },
  );

  test("prefers the most specific pattern regardless of declaration order", () => {
    // `/workspaces` and `/workspaces/*/invoices` both match; the deeper one wins.
    expect(resolveFeedbackArea("/workspaces/ws_7f2/invoices")).not.toBe(
      resolveFeedbackArea("/workspaces/ws_7f2"),
    );
    expect(resolveFeedbackArea("/law/cases")).not.toBe(
      resolveFeedbackArea("/law"),
    );
  });

  test("falls back instead of guessing for an unmapped or empty route", () => {
    for (const pathname of ["/", "", "/agent-claim/x", "/consent"]) {
      expect(resolveFeedbackArea(pathname)).toBe(FEEDBACK_FALLBACK_AREA);
    }
  });

  test("ignores a trailing slash and a partial segment match", () => {
    expect(resolveFeedbackArea("/contacts/")).toBe("contacts");
    expect(resolveFeedbackArea("/contacts-export")).toBe(
      FEEDBACK_FALLBACK_AREA,
    );
  });

  test("covers every contract area exactly once, in both directions", () => {
    const routed = new Set<FeedbackArea>(Object.values(ROUTE_AREA_PATTERNS));

    expect([...routed].toSorted()).toEqual(
      FEEDBACK_AREAS.filter(
        (area) => !AREAS_WITHOUT_A_WEB_ROUTE.has(area),
      ).toSorted(),
    );
    for (const area of AREAS_WITHOUT_A_WEB_ROUTE) {
      expect(routed.has(area)).toBe(false);
      expect(FEEDBACK_AREAS).toContain(area);
    }
  });
});

describe("feedback picker labels", () => {
  test("names every contract kind and area", () => {
    expect(Object.keys(FEEDBACK_KIND_LABEL_KEYS).toSorted()).toEqual(
      [...FEEDBACK_KINDS].toSorted(),
    );
    expect(Object.keys(FEEDBACK_AREA_LABEL_KEYS).toSorted()).toEqual(
      [...FEEDBACK_AREAS].toSorted(),
    );
  });

  test("gives each kind and area its own string", () => {
    const keys = [
      ...Object.values(FEEDBACK_KIND_LABEL_KEYS),
      ...Object.values(FEEDBACK_AREA_LABEL_KEYS),
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });
});
