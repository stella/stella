import { describe, expect, test } from "bun:test";

import { DEFAULT_SEARCH_EXCERPT } from "@stll/api-contract/search";

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
   * A page begins at its number times its size: the same filters read at a
   * different page size are a different slice, so they must not share a
   * cache identity or page 3 of one would be served from the other.
   */
  test("the page size is part of the window's identity", () => {
    const filters = {
      country: "CZE",
      excerpt: DEFAULT_SEARCH_EXCERPT,
      search: "výpověď",
    };
    const twentyFive = decisionTableAdapter.useListPage({
      filters,
      page: 3,
      pageSize: 25,
    });
    const hundred = decisionTableAdapter.useListPage({
      filters,
      page: 3,
      pageSize: 100,
    });

    expect(twentyFive.queryKey).not.toEqual(hundred.queryKey);
  });

  test("each page of a search is its own window", () => {
    const filters = {
      country: "CZE",
      excerpt: DEFAULT_SEARCH_EXCERPT,
      search: "výpověď",
    };

    expect(
      decisionTableAdapter.useListPage({ filters, page: 2, pageSize: 25 })
        .queryKey,
    ).not.toEqual(
      decisionTableAdapter.useListPage({ filters, page: 3, pageSize: 25 })
        .queryKey,
    );
  });

  test("the same page of the same search is the same window", () => {
    const filters = {
      country: "CZE",
      excerpt: DEFAULT_SEARCH_EXCERPT,
      search: "výpověď",
    };

    expect(
      decisionTableAdapter.useListPage({ filters, page: 1, pageSize: 25 })
        .queryKey,
    ).toEqual(
      decisionTableAdapter.useListPage({
        filters: { ...filters },
        page: 1,
        pageSize: 25,
      }).queryKey,
    );
  });

  // The excerpt length is answered by the search, not trimmed afterwards, so
  // the same words read at two lengths are two result sets. Sharing a cache
  // identity would leave a reader who asked for more text looking at the rows
  // that answered the shorter question.
  test("a different excerpt length is a different window", () => {
    const filters = { country: "CZE", search: "výpověď" };

    expect(
      decisionTableAdapter.useListPage({
        filters: { ...filters, excerpt: "short" },
        page: 1,
        pageSize: 25,
      }).queryKey,
    ).not.toEqual(
      decisionTableAdapter.useListPage({
        filters: { ...filters, excerpt: "long" },
        page: 1,
        pageSize: 25,
      }).queryKey,
    );
  });

  test("a different search is a different window", () => {
    expect(
      decisionTableAdapter.useListPage({
        filters: {
          country: "CZE",
          excerpt: DEFAULT_SEARCH_EXCERPT,
          search: "a",
        },
        page: 1,
        pageSize: 25,
      }).queryKey,
    ).not.toEqual(
      decisionTableAdapter.useListPage({
        filters: {
          country: "CZE",
          excerpt: DEFAULT_SEARCH_EXCERPT,
          search: "b",
        },
        page: 1,
        pageSize: 25,
      }).queryKey,
    );
  });

  test("one decision is read by its own id", () => {
    expect(decisionTableAdapter.detail("decision-1").queryKey).not.toEqual(
      decisionTableAdapter.detail("decision-2").queryKey,
    );
  });
});
