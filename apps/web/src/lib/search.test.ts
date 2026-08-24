import { describe, expect, test } from "bun:test";

import { resourceRef, RESOURCE_TYPE, toResourceName } from "@stll/api-contract";
import type { GlobalSearchHit } from "@stll/api/types";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { toSafeId } from "@/lib/safe-id";
import {
  getFirstSearchHighlightText,
  getNativeSearchDocumentPreviewTarget,
  getSearchHighlightText,
  getSearchPreviewRenderContent,
  getSearchPreviewDate,
  getSearchPreviewTarget,
  normalizeSearchQuery,
  selectAuthorizedSearchPreviewData,
  selectDisplayedSearchPreviewHit,
  selectSearchPreviewHit,
  shouldShowNativeSearchFallback,
  shouldShowSearchPreview,
} from "@/lib/search.logic";
import type { SearchPreviewChatMessage } from "@/lib/search.logic";

process.env["VITE_API_URL"] ??= "http://localhost:3001";

const SEARCH_TEST_RESOURCES = {
  caseLawDecision: resourceRef({
    type: RESOURCE_TYPE.CASE_LAW_DECISION,
    id: toSafeId<"caseLawDecision">("decision_1"),
  }),
  chatThread: resourceRef({
    type: RESOURCE_TYPE.CHAT_THREAD,
    id: toSafeId<"chatThread">("thread_1"),
  }),
  contact: resourceRef({
    type: RESOURCE_TYPE.CONTACT,
    id: toSafeId<"contact">("contact_1"),
  }),
  entity: resourceRef({
    type: RESOURCE_TYPE.ENTITY,
    id: toSafeId<"entity">("entity_1"),
  }),
  workspace: resourceRef({
    type: RESOURCE_TYPE.WORKSPACE,
    id: toSafeId<"workspace">("ws_1"),
  }),
} as const;

const {
  hasSearchQueryOrSelectiveFilter,
  recentFilePreviewFieldOptions,
  resolveRecentFilePreviewFieldId,
  SEARCH_PREVIEW_ACCESS_RECHECK_MS,
  searchInfiniteOptions,
  searchPreviewOptions,
} = await import("@/lib/search");

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

  test("uses server-located terms for native document highlighting", () => {
    expect(
      getSearchHighlightText({
        headline: "The <mark>Closing</mark> memorandum",
        query: "closing memo",
      }),
    ).toBe("Closing");
    expect(
      getSearchHighlightText({ headline: null, query: "  closing memo " }),
    ).toBe("closing memo");
    expect(
      getSearchHighlightText({
        headline: "The <mark>Closing</mark> memorandum",
        query: "",
      }),
    ).toBe("Closing");
    expect(
      getSearchHighlightText({
        headline:
          "The <mark>R&amp;D</mark> team&#x27;s <mark>&lt;draft&gt;</mark>",
        query: "",
      }),
    ).toEqual({ type: "separate-terms", terms: ["R&D", "<draft>"] });
  });

  test("excludes advanced-query operators and negated terms from previews", () => {
    expect(
      getSearchHighlightText({
        headline: "<mark>indemnity</mark> and <mark>liability</mark>",
        query: "indemnity AND liability NOT superseded",
      }),
    ).toEqual({
      type: "separate-terms",
      terms: ["indemnity", "liability"],
    });
    expect(
      getSearchHighlightText({
        headline: null,
        previewLocatorCandidates: ["indemnity", "liability"],
        query: "indemnity OR liability NOT superseded",
      }),
    ).toEqual({
      type: "separate-terms",
      terms: ["indemnity", "liability"],
    });
    expect(
      getSearchHighlightText({
        headline: null,
        previewLocatorCandidates: ["closing memo"],
        query: '"closing memo" NOT draft',
      }),
    ).toBe("closing memo");
  });

  test("uses one marked passage for case-law deep links", () => {
    expect(
      getFirstSearchHighlightText(
        "<mark>indemnity</mark> and <mark>liability</mark>",
        "",
      ),
    ).toBe("indemnity");
    expect(getFirstSearchHighlightText(null, "  closing memo ")).toBe(
      "closing memo",
    );
  });
});

describe("search preview targets", () => {
  const previewHit = {
    headline: null,
    id: "document:entity_1",
    resource: SEARCH_TEST_RESOURCES.entity,
    resourceName: toResourceName(SEARCH_TEST_RESOURCES.entity),
    type: "document",
    title: "Result",
    updatedAt: "2026-07-29T12:00:00.000Z",
    entityId: "entity_1",
    workspaceId: "ws_1",
    workspaceName: "Matter",
    parentId: null,
    lastEditedByName: null,
    lastEditedByImage: null,
    fileFieldId: null,
    filePropertyId: null,
    mimeType: null,
  } as const satisfies GlobalSearchHit;

  test("isolates cached previews by organization and user", () => {
    const params = {
      organizationId: "org_1",
      userId: "user_1",
      query: "current terms",
      resultId: "entity_1",
      type: "document",
      updatedAt: previewHit.updatedAt,
    } as const;
    const ownerA = searchPreviewOptions(params);
    const organizationB = searchPreviewOptions({
      ...params,
      organizationId: "org_2",
    });
    const userB = searchPreviewOptions({ ...params, userId: "user_2" });

    expect(organizationB.queryKey).not.toEqual(ownerA.queryKey);
    expect(userB.queryKey).not.toEqual(ownerA.queryKey);
  });

  test("isolates legacy recent-file field resolution by owner", () => {
    const params = {
      entityId: "entity_1",
      fileFieldId: "field_2",
      filePropertyId: "property_2",
      mimeType: "application/pdf",
      organizationId: "org_1",
      userId: "user_1",
      workspaceId: "workspace_1",
    };
    const ownerA = recentFilePreviewFieldOptions(params);
    const organizationB = recentFilePreviewFieldOptions({
      ...params,
      organizationId: "org_2",
    });
    const userB = recentFilePreviewFieldOptions({
      ...params,
      userId: "user_2",
    });

    expect(organizationB.queryKey).not.toEqual(ownerA.queryKey);
    expect(userB.queryKey).not.toEqual(ownerA.queryKey);
    expect(
      recentFilePreviewFieldOptions({ ...params, fileFieldId: "field_1" })
        .queryKey,
    ).not.toEqual(ownerA.queryKey);
    expect(
      recentFilePreviewFieldOptions({
        ...params,
        filePropertyId: "property_1",
      }).queryKey,
    ).not.toEqual(ownerA.queryKey);
  });

  test("preserves recent attachment identity across current revisions", () => {
    const fields = [
      {
        content: { mimeType: "application/pdf", type: "file" },
        id: "field_1",
        propertyId: "property_1",
      },
      {
        content: {
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          type: "file",
        },
        id: "field_2",
        propertyId: "property_2",
      },
    ];

    expect(
      resolveRecentFilePreviewFieldId({
        fields,
        fileFieldId: "field_2",
        filePropertyId: "property_1",
        mimeType: "application/pdf",
      }),
    ).toBe("field_2");
    expect(
      resolveRecentFilePreviewFieldId({
        fields,
        fileFieldId: "deleted_field",
        filePropertyId: "deleted_property",
        mimeType: "application/pdf",
      }),
    ).toBeNull();
    expect(
      resolveRecentFilePreviewFieldId({
        fields,
        fileFieldId: "field_from_old_revision",
        filePropertyId: "property_2",
        mimeType: "application/pdf",
      }),
    ).toBe("field_2");
    expect(
      resolveRecentFilePreviewFieldId({
        fields,
        mimeType: "application/pdf",
      }),
    ).toBe("field_1");
  });

  test("re-checks recent-file identity per session, not per hover", () => {
    const options = recentFilePreviewFieldOptions({
      entityId: "entity_1",
      fileFieldId: "field_1",
      filePropertyId: "property_1",
      mimeType: "application/pdf",
      organizationId: "org_1",
      userId: "user_1",
      workspaceId: "workspace_1",
    });

    // This query doubles as the access re-check for a recent file, so the
    // window must stay short — but nonzero, or hovering between recents
    // refires it on every switch.
    expect(options.staleTime).toBe(SEARCH_PREVIEW_ACCESS_RECHECK_MS);
  });

  test("caches previews within a search session", () => {
    const options = searchPreviewOptions({
      organizationId: "org_1",
      userId: "user_1",
      query: "current terms",
      resultId: "entity_1",
      type: "document",
      updatedAt: previewHit.updatedAt,
    });

    // The key is content-addressed (query + resultId + updatedAt), so caching
    // can never show stale content; it only defers the per-mount access
    // re-check, bounded by the same window as the recent-file re-check
    // above. No refetchOnMount override — hovering back to an
    // already-previewed hit must be a cache hit.
    expect(options.refetchOnMount).toBeUndefined();
    expect(options.staleTime).toBe(SEARCH_PREVIEW_ACCESS_RECHECK_MS);
    expect(SEARCH_PREVIEW_ACCESS_RECHECK_MS).toBeLessThanOrEqual(30_000);
  });

  test("shows the preview only when enabled on a non-mobile viewport", () => {
    for (const testCase of [
      { expected: true, isMobile: false, previewEnabled: true },
      { expected: false, isMobile: true, previewEnabled: true },
      { expected: false, isMobile: false, previewEnabled: false },
      { expected: false, isMobile: true, previewEnabled: false },
    ]) {
      expect(shouldShowSearchPreview(testCase)).toBe(testCase.expected);
    }
  });

  test("does not reserve a preview pane without a current result", () => {
    expect(
      selectDisplayedSearchPreviewHit({ hit: null, showPreview: true }),
    ).toBeNull();
    expect(
      selectDisplayedSearchPreviewHit({
        hit: previewHit,
        showPreview: false,
      }),
    ).toBeNull();
    expect(
      selectDisplayedSearchPreviewHit({ hit: previewHit, showPreview: true }),
    ).toBe(previewHit);
  });

  test("uses server text only after a native search settles without matches", () => {
    expect(
      shouldShowNativeSearchFallback({
        searchText: "indemnity",
        status: "unmatched",
      }),
    ).toBeTrue();
    expect(
      shouldShowNativeSearchFallback({
        searchText: "indemnity",
        status: "pending",
      }),
    ).toBeFalse();
    expect(
      shouldShowNativeSearchFallback({ searchText: "", status: "unmatched" }),
    ).toBeFalse();
  });

  test("routes PDF and DOCX documents to the native inspector viewer", () => {
    expect(
      getNativeSearchDocumentPreviewTarget({
        ...previewHit,
        fileFieldId: "field_pdf",
        mimeType: "application/pdf",
      }),
    ).toEqual({
      entityId: "entity_1",
      fieldId: "field_pdf",
      filePurpose: "display",
      mimeType: "application/pdf",
      workspaceId: "ws_1",
    });
    expect(
      getNativeSearchDocumentPreviewTarget({
        ...previewHit,
        fileFieldId: "field_docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toEqual({
      entityId: "entity_1",
      fieldId: "field_docx",
      filePurpose: "native-display",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      workspaceId: "ws_1",
    });
  });

  test("keeps unsupported and unresolved documents on the text path", () => {
    expect(
      getNativeSearchDocumentPreviewTarget({
        ...previewHit,
        fileFieldId: null,
        filePropertyId: null,
        mimeType: "application/pdf",
      }),
    ).toBeNull();
    expect(
      getNativeSearchDocumentPreviewTarget({
        ...previewHit,
        fileFieldId: "field_text",
        mimeType: "text/plain",
      }),
    ).toBeNull();
  });

  test("shows cache-hit preview data without waiting for a mount fetch", () => {
    const data = {
      type: "plain-text",
      content: "Privileged preview",
    } as const;

    // Regression: the old per-mount reauthorization gate combined with
    // searchPreviewOptions' staleTime left cache hits (no fetch after mount)
    // on a permanent skeleton.
    expect(
      selectAuthorizedSearchPreviewData({
        data,
        isError: false,
      }),
    ).toBe(data);
  });

  test("withholds stale data after a preview authorization error", () => {
    expect(
      selectAuthorizedSearchPreviewData({
        data: {
          type: "plain-text",
          content: "Previously authorized preview",
        },
        isError: true,
      }),
    ).toBeUndefined();
  });

  test("keeps literal highlight sentinels on the plain-text render path", () => {
    const content = "<script>literal</script> __HL_START__code__HL_STOP__";

    expect(
      getSearchPreviewRenderContent({ type: "plain-text", content }),
    ).toEqual({
      type: "plain-text",
      directionText: content,
      text: content,
    });
  });

  test("exposes trusted markup only for highlighted preview content", () => {
    expect(
      getSearchPreviewRenderContent({
        type: "highlighted-html",
        content: "<mark>résumé</mark>",
      }),
    ).toEqual({
      type: "highlighted-html",
      directionText: "résumé",
      html: "<mark>résumé</mark>",
    });
  });

  test("preserves structured chat messages for native bubble rendering", () => {
    const messages = [
      { id: "message_1", role: "user", content: "Review this" },
      { id: "message_2", role: "assistant", content: "## Review" },
    ] satisfies SearchPreviewChatMessage[];

    expect(
      getSearchPreviewRenderContent({
        type: "chat-messages",
        messages: [...messages],
      }),
    ).toEqual({ type: "chat-messages", messages });
  });

  test("withholds previews while hits belong to the previous query", () => {
    expect(
      selectSearchPreviewHit({
        highlightedHitId: previewHit.id,
        hits: [previewHit],
        isPlaceholderData: true,
      }),
    ).toBeNull();
  });

  test("selects the highlighted current-query hit", () => {
    expect(
      selectSearchPreviewHit({
        highlightedHitId: previewHit.id,
        hits: [previewHit],
        isPlaceholderData: false,
      }),
    ).toBe(previewHit);
  });

  test("selects a hit when filters produce results without query text", () => {
    expect(
      selectSearchPreviewHit({
        highlightedHitId: previewHit.id,
        hits: [previewHit],
        isPlaceholderData: false,
      }),
    ).toBe(previewHit);
  });

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
        resource: SEARCH_TEST_RESOURCES.workspace,
        resourceName: toResourceName(SEARCH_TEST_RESOURCES.workspace),
        type: "matter",
        workspaceId: "ws_1",
        workspaceName: "Matter",
        color: null,
      },
      {
        ...base,
        id: "contact:contact_1",
        resource: SEARCH_TEST_RESOURCES.contact,
        resourceName: toResourceName(SEARCH_TEST_RESOURCES.contact),
        type: "contact",
        contactId: "contact_1",
        contactType: "person",
      },
      {
        ...base,
        id: "case-law:decision_1",
        resource: SEARCH_TEST_RESOURCES.caseLawDecision,
        resourceName: toResourceName(SEARCH_TEST_RESOURCES.caseLawDecision),
        type: "case-law",
        decisionId: "decision_1",
        caseNumber: "1 T 1/2026",
        identifiers: [
          {
            type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
            value: "1 T 1/2026",
          },
        ],
        court: "Court",
        country: "CZ",
        decisionDate: null,
      },
      {
        ...base,
        id: "chat:thread_1",
        resource: SEARCH_TEST_RESOURCES.chatThread,
        resourceName: toResourceName(SEARCH_TEST_RESOURCES.chatThread),
        type: "chat",
        threadId: "thread_1",
        workspaceId: null,
        workspaceName: null,
      },
      {
        ...base,
        id: "document:entity_1",
        resource: SEARCH_TEST_RESOURCES.entity,
        resourceName: toResourceName(SEARCH_TEST_RESOURCES.entity),
        type: "document",
        entityId: "entity_1",
        workspaceId: "ws_1",
        workspaceName: "Matter",
        parentId: null,
        lastEditedByName: null,
        lastEditedByImage: null,
        fileFieldId: null,
        filePropertyId: null,
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

describe("search preview dates", () => {
  const base = {
    headline: null,
    id: "case-law:decision_1",
    resource: SEARCH_TEST_RESOURCES.caseLawDecision,
    resourceName: toResourceName(SEARCH_TEST_RESOURCES.caseLawDecision),
    type: "case-law",
    title: "1 T 1/2026 - Court",
    updatedAt: "2026-07-29T12:00:00.000Z",
    decisionId: "decision_1",
    caseNumber: "1 T 1/2026",
    identifiers: [
      {
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "1 T 1/2026",
      },
    ],
    court: "Court",
    country: "CZ",
  } as const;

  test("uses the ruling date for case-law metadata", () => {
    const hit = {
      ...base,
      decisionDate: "2024-02-15",
    } satisfies GlobalSearchHit;

    expect(getSearchPreviewDate(hit)).toEqual({
      type: "calendar-date",
      value: "2024-02-15",
    });
  });

  test("omits case-law metadata when the ruling date is absent", () => {
    const hit = {
      ...base,
      decisionDate: null,
    } satisfies GlobalSearchHit;

    expect(getSearchPreviewDate(hit)).toBeNull();
  });

  test("uses the update instant for other result types", () => {
    const hit = {
      headline: null,
      id: "contact:contact_1",
      resource: SEARCH_TEST_RESOURCES.contact,
      resourceName: toResourceName(SEARCH_TEST_RESOURCES.contact),
      type: "contact",
      title: "Contact",
      updatedAt: "2026-07-29T12:00:00.000Z",
      contactId: "contact_1",
      contactType: "person",
    } as const satisfies GlobalSearchHit;

    expect(getSearchPreviewDate(hit)).toEqual({
      type: "instant",
      value: hit.updatedAt,
    });
  });
});
