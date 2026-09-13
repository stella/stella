import { describe, expect, test } from "bun:test";

import { decisionTableAdapter } from "@/features/case-law/decision-table-adapter";
import type { DecisionTableAdapterKeys } from "@/features/case-law/decision-table-adapter";
import type { WorkspaceTableAdapter } from "@/lib/workspaces/table-adapter";

describe("where the decision table's rows come from", () => {
  // Total over the adapter's own keys, so a row source added to the decision
  // table cannot skip being named here: `satisfies` fails to compile until it
  // is.
  const COVERED = {
    useListPage: true,
    detail: true,
  } as const satisfies Record<
    keyof WorkspaceTableAdapter<DecisionTableAdapterKeys>,
    true
  >;

  test("the table reads rows through exactly these entry points", () => {
    expect(Object.keys(decisionTableAdapter).toSorted()).toEqual(
      Object.keys(COVERED).toSorted(),
    );
  });

  test("decisions never group, so no section entry is offered", () => {
    expect(Object.keys(decisionTableAdapter)).not.toContain("useSectionPage");
    expect(Object.keys(decisionTableAdapter)).not.toContain("sectionCounts");
  });

  test("every entry point is a factory the caller invokes itself", () => {
    for (const entry of Object.values(decisionTableAdapter)) {
      expect(typeof entry).toBe("function");
    }
  });

  /**
   * Paging is the cursor chain the page walks: the same filters read at a
   * different page size are a different chain, so they must not share a cache
   * identity or page 3 of one would be served from the other.
   */
  test("the page size is part of the window's identity", () => {
    const filters = { country: "CZE", search: "výpověď" };
    const twentyFive = decisionTableAdapter.useListPage(filters, 25);
    const hundred = decisionTableAdapter.useListPage(filters, 100);

    expect(twentyFive.queryKey).not.toEqual(hundred.queryKey);
  });

  test("the same page of the same search is the same window", () => {
    const filters = { country: "CZE", search: "výpověď" };

    expect(decisionTableAdapter.useListPage(filters, 25).queryKey).toEqual(
      decisionTableAdapter.useListPage({ ...filters }, 25).queryKey,
    );
  });

  test("a different search is a different window", () => {
    expect(
      decisionTableAdapter.useListPage({ country: "CZE", search: "a" }, 25)
        .queryKey,
    ).not.toEqual(
      decisionTableAdapter.useListPage({ country: "CZE", search: "b" }, 25)
        .queryKey,
    );
  });

  test("one decision is read by its own id", () => {
    expect(decisionTableAdapter.detail("decision-1").queryKey).not.toEqual(
      decisionTableAdapter.detail("decision-2").queryKey,
    );
  });
});
