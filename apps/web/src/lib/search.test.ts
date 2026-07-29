import { describe, expect, test } from "bun:test";

import type { GlobalSearchHit } from "@stll/api/types";

import {
  getSearchPreviewTarget,
  normalizeSearchQuery,
} from "@/lib/search.logic";

process.env["VITE_API_URL"] ??= "http://localhost:3001";

const { hasSearchQueryOrSelectiveFilter, searchInfiniteOptions } =
  await import("@/lib/search");

const emptySearch = () => ({
  editedByUserIds: [],
  kinds: [],
  mimeTypes: [],
  organizationId: "org_1",
  query: "",
  types: [],
  userId: "user_1",
});

type SearchEnablementParams = Parameters<
  typeof hasSearchQueryOrSelectiveFilter
>[0];

const selectiveFilterCases = [
  { name: "an entity kind", values: { kinds: ["document"] } },
  { name: "a result type", values: { types: ["document"] } },
  { name: "an editor", values: { editedByUserIds: ["user_1"] } },
  { name: "a MIME type", values: { mimeTypes: ["application/pdf"] } },
  {
    name: "an updated-from timestamp",
    values: { updatedFrom: "2026-04-23T12:00:00.000Z" },
  },
  {
    name: "an updated-to timestamp",
    values: { updatedTo: "2026-04-30T12:00:00.000Z" },
  },
] satisfies {
  name: string;
  values: Partial<SearchEnablementParams>;
}[];

describe("search query enablement", () => {
  test("does not run a blank query scoped only to a workspace", () => {
    expect(
      hasSearchQueryOrSelectiveFilter({
        ...emptySearch(),
        workspaceIds: ["ws_1"],
      }),
    ).toBeFalse();
  });

  test.each(selectiveFilterCases)(
    "runs a blank query with $name",
    ({ values }) => {
      expect(
        hasSearchQueryOrSelectiveFilter({
          ...emptySearch(),
          ...values,
        }),
      ).toBeTrue();
    },
  );

  test("uses the caller-owned gate without splitting the result cache", () => {
    const params = { ...emptySearch(), enabled: false, workspaceIds: [] };
    const disabled = searchInfiniteOptions(params);
    const enabled = searchInfiniteOptions({ ...params, enabled: true });

    expect(disabled.enabled).toBeFalse();
    expect(enabled.enabled).toBeTrue();
    expect(enabled.queryKey).toEqual(disabled.queryKey);
  });

  test("isolates cached results by organization and user", () => {
    const params = { ...emptySearch(), enabled: true, workspaceIds: [] };
    const ownerA = searchInfiniteOptions(params);
    const organizationB = searchInfiniteOptions({
      ...params,
      organizationId: "org_2",
    });
    const userB = searchInfiniteOptions({ ...params, userId: "user_2" });

    expect(organizationB.queryKey).not.toEqual(ownerA.queryKey);
    expect(userB.queryKey).not.toEqual(ownerA.queryKey);
  });
});

describe("search query normalization", () => {
  test("removes boundary whitespace without changing internal terms", () => {
    expect(normalizeSearchQuery("  closing   memo \n")).toBe("closing   memo");
  });

  test("turns whitespace-only input into an empty query", () => {
    expect(normalizeSearchQuery(" \t\n ")).toBe("");
  });
});

describe("search preview targets", () => {
  test("uses the authorized resource identifier for every hit type", () => {
    const base = {
      headline: null,
      title: "Result",
      updatedAt: "2026-07-29T12:00:00.000Z",
    };
    const hits = [
      {
        ...base,
        id: "matter:ws_1",
        type: "matter",
        workspaceId: "ws_1",
        workspaceName: "Matter",
        color: null,
      },
      {
        ...base,
        id: "contact:contact_1",
        type: "contact",
        contactId: "contact_1",
        contactType: "person",
      },
      {
        ...base,
        id: "case-law:decision_1",
        type: "case-law",
        decisionId: "decision_1",
        caseNumber: "1 T 1/2026",
        court: "Court",
        country: "CZ",
        decisionDate: null,
      },
      {
        ...base,
        id: "chat:thread_1",
        type: "chat",
        threadId: "thread_1",
        workspaceId: null,
        workspaceName: null,
      },
      {
        ...base,
        id: "document:entity_1",
        type: "document",
        entityId: "entity_1",
        workspaceId: "ws_1",
        workspaceName: "Matter",
        lastEditedByName: null,
        lastEditedByImage: null,
        mimeType: null,
      },
    ] as const satisfies readonly GlobalSearchHit[];

    expect(hits.map(getSearchPreviewTarget)).toEqual([
      { resultId: "ws_1", type: "matter" },
      { resultId: "contact_1", type: "contact" },
      { resultId: "decision_1", type: "case-law" },
      { resultId: "thread_1", type: "chat" },
      { resultId: "entity_1", type: "document" },
    ]);
  });
});
