import { describe, expect, test } from "bun:test";

import {
  GLOBAL_SEARCH_RESULT_TYPES,
  resourceRef,
  RESOURCE_TYPE,
  toResourceName,
} from "@stll/api-contract";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type {
  GlobalSearchHit,
  GlobalSearchResultType,
} from "@/lib/api-contract";
import { toSafeId } from "@/lib/safe-id";

import {
  canUseAskAIShortcut,
  createDialogCloseActionQueue,
  getCaseLawHitRoute,
  getChatHitRoute,
  getCompanySearchQuery,
  getEntityLocation,
  getRecentFileLocation,
  getRecentFileRoute,
  getRecentFilePreviewDateVisibility,
  getRecentFilePreviewHit,
  isLazySearchGroupActive,
  resolveRegistryResultsPane,
  rememberSelectedFacetLabels,
  resolveEntityDocumentRoute,
  resolveEagerSearchTypes,
  toAskAIMessageHtml,
} from "./search-dialog.logic";

type CaseLawGlobalSearchHit = Extract<GlobalSearchHit, { type: "case-law" }>;
type ChatGlobalSearchHit = Extract<GlobalSearchHit, { type: "chat" }>;

describe("lazy search groups", () => {
  test("gives the results pane to an expanded registry group only in All scope", () => {
    for (const scope of ["all", "matters", "registries"] as const) {
      for (const expanded of [false, true]) {
        const visible = true;
        expect(
          resolveRegistryResultsPane({
            scope,
            expanded,
            visible,
            registryVisible: scope === "registries",
            caseLawEnabled: true,
          }),
        ).toEqual({
          active: scope === "all" && expanded,
          hideMatterChrome:
            scope === "registries" || (scope === "all" && expanded),
          caseLawEnabled: !(scope === "all" && expanded),
        });
      }
    }
    expect(
      resolveRegistryResultsPane({
        scope: "all",
        expanded: true,
        visible: false,
        registryVisible: false,
        caseLawEnabled: true,
      }),
    ).toEqual({
      active: false,
      hideMatterChrome: false,
      caseLawEnabled: true,
    });
  });

  test("defers only case law in All browse searches while preserving every other type and its order", () => {
    const modes = ["browse", "pick"] as const;
    const scopes = ["all", "matters", "registries"] as const;
    const inputs = [
      [],
      [...GLOBAL_SEARCH_RESULT_TYPES],
      GLOBAL_SEARCH_RESULT_TYPES.toReversed(),
      ...GLOBAL_SEARCH_RESULT_TYPES.map((type) => [type]),
      ...GLOBAL_SEARCH_RESULT_TYPES.map(
        (type) => [type, "case-law", type] satisfies GlobalSearchResultType[],
      ),
    ];
    for (const mode of modes) {
      for (const scope of scopes) {
        for (const types of inputs) {
          const original = [...types];
          const result = resolveEagerSearchTypes({ mode, scope, types });
          expect(types).toEqual(original);
          if (mode !== "browse" || scope !== "all") {
            expect(result).toEqual(original);
            continue;
          }
          expect(result).not.toContain("case-law");
          const expected = [...original];
          while (expected.includes("case-law")) {
            expected.splice(expected.indexOf("case-law"), 1);
          }
          expect(result).toEqual(expected);
        }
      }
    }
  });

  test("only starts an expanded group in an open All browse search", () => {
    const modes = ["browse", "pick"] as const;
    const scopes = ["all", "matters", "registries"] as const;
    const queries = ["", " ", "\t\n", "\u00a0", "ALZA", " 27082440 ", "عقد"];
    let activeStates = 0;
    for (const open of [false, true]) {
      for (const mode of modes) {
        for (const scope of scopes) {
          for (const expanded of [false, true]) {
            for (const query of queries) {
              const active = isLazySearchGroupActive({
                open,
                mode,
                scope,
                expanded,
                query,
              });
              if (
                !open ||
                mode === "pick" ||
                scope !== "all" ||
                !expanded ||
                query.trim() === ""
              ) {
                expect(active).toBe(false);
              } else {
                expect(active).toBe(true);
                activeStates += 1;
              }
            }
          }
        }
      }
    }
    expect(activeStates).toBe(3);
  });
});

describe("company registry search query", () => {
  test.each([
    ["1", "1"],
    ["12345678", "12345678"],
    ["00123456", "00123456"],
  ])(
    "keeps a numeric company id (%s) for registry lookup",
    (query, expected) => {
      expect(
        getCompanySearchQuery({
          debouncedQuery: query,
          mode: "browse",
          open: true,
          query,
        }),
      ).toBe(expected);
    },
  );

  test.each(["a".repeat(257)])(
    "rejects an oversized company registry query (%j)",
    (query) => {
      expect(
        getCompanySearchQuery({
          debouncedQuery: query,
          mode: "browse",
          open: true,
          query,
        }),
      ).toBeNull();
    },
  );

  test.each(["", "   "])(
    "keeps an empty query eligible for registry source selection (%j)",
    (query) => {
      expect(
        getCompanySearchQuery({
          open: true,
          mode: "browse",
          query,
          debouncedQuery: query,
        }),
      ).toBe("");
    },
  );

  test("keeps a debounced company name query for registry lookup", () => {
    expect(
      getCompanySearchQuery({
        debouncedQuery: "Acme Legal Services",
        mode: "browse",
        open: true,
        query: "Acme Legal Services",
      }),
    ).toBe("Acme Legal Services");
  });

  test.each([
    {
      open: false,
      mode: "browse" as const,
      query: "123",
      debouncedQuery: "123",
    },
    { open: true, mode: "pick" as const, query: "123", debouncedQuery: "123" },
    {
      open: true,
      mode: "browse" as const,
      query: "1234",
      debouncedQuery: "123",
    },
  ])("rejects a query when the overlay state is not eligible", (options) => {
    expect(getCompanySearchQuery(options)).toBeNull();
  });
});

const chatHit = (
  overrides: Pick<ChatGlobalSearchHit, "threadId" | "workspaceId">,
): ChatGlobalSearchHit => {
  const resource = resourceRef({
    type: RESOURCE_TYPE.CHAT_THREAD,
    id: toSafeId<"chatThread">(overrides.threadId),
  });

  return {
    id: `chat:${overrides.threadId}`,
    type: "chat",
    resource,
    resourceName: toResourceName(resource),
    title: "Review privilege memo",
    headline: null,
    updatedAt: "2026-06-06T10:00:00.000Z",
    threadId: overrides.threadId,
    workspaceId: overrides.workspaceId,
    workspaceName: overrides.workspaceId ? "Matter Alpha" : null,
  };
};

describe("search chat result routing", () => {
  test("opens global chat hits on the global chat route", () => {
    expect(
      getChatHitRoute(
        chatHit({ threadId: "thread-global", workspaceId: null }),
      ),
    ).toEqual({
      to: "/chat/$threadId",
      params: { threadId: "thread-global" },
    });
  });

  test("opens workspace chat hits on the workspace-scoped chat route", () => {
    expect(
      getChatHitRoute(
        chatHit({ threadId: "thread-workspace", workspaceId: "workspace-1" }),
      ),
    ).toEqual({
      to: "/chat/workspaces/$workspaceId/$threadId",
      params: { workspaceId: "workspace-1", threadId: "thread-workspace" },
    });
  });
});

describe("search dialog case-law routes", () => {
  const decisionId = "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
  const decisionResource = resourceRef({
    type: RESOURCE_TYPE.CASE_LAW_DECISION,
    id: toSafeId<"caseLawDecision">(decisionId),
  });
  const caseLawHit = (
    overrides: Pick<
      CaseLawGlobalSearchHit,
      "language" | "languageAlternates" | "slug"
    >,
  ): CaseLawGlobalSearchHit => ({
    id: `case-law:${decisionId}`,
    type: "case-law",
    resource: decisionResource,
    resourceName: toResourceName(decisionResource),
    decisionId,
    caseNumber: "C-1/24",
    identifiers: [
      { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: "C-1/24" },
    ],
    court: "Court of Justice",
    country: "EU",
    decisionDate: null,
    title: "C-1/24 - Court of Justice",
    headline: "The <mark>indemnity</mark> clause",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  });

  test("opens a hit on its stored slug, at the matched words", () => {
    expect(
      getCaseLawHitRoute(
        caseLawHit({ language: "en", languageAlternates: [], slug: "c-1-24" }),
      ),
    ).toEqual({
      to: "/law/$country/cases/$court/$slug",
      params: { country: "eu", court: "court-of-justice", slug: "c-1-24" },
      search: { q: "indemnity" },
    });
  });

  test("names the language of a hit published in several", () => {
    expect(
      getCaseLawHitRoute(
        caseLawHit({
          language: "fr",
          languageAlternates: [{ language: "en" }, { language: "fr" }],
          slug: "c-1-24-fr",
        }),
      ),
    ).toEqual({
      to: "/law/$country/cases/$court/$language/$slug",
      params: {
        country: "eu",
        court: "court-of-justice",
        language: "fr",
        slug: "c-1-24-fr",
      },
      search: { q: "indemnity" },
    });
  });

  test("falls back to the id form only for a hit without a stored slug", () => {
    const route = getCaseLawHitRoute(
      caseLawHit({ language: "en", languageAlternates: [], slug: null }),
    );

    expect(route.to).toBe("/law/$country/cases/$court/$slug");
    expect(route.params.slug.startsWith("c-1-24--")).toBeTrue();
  });
});

describe("search dialog close actions", () => {
  test("runs a queued route action once, only after close completes", () => {
    const queue = createDialogCloseActionQueue();
    let runCount = 0;

    queue.schedule(() => {
      runCount += 1;
    });

    expect(runCount).toBe(0);
    queue.complete(false);
    expect(runCount).toBe(1);
    queue.complete(false);
    expect(runCount).toBe(1);
  });

  test("discards a queued route action if the dialog reopens", () => {
    const queue = createDialogCloseActionQueue();
    let runCount = 0;

    queue.schedule(() => {
      runCount += 1;
    });
    queue.complete(true);
    queue.complete(false);

    expect(runCount).toBe(0);
  });
});

describe("search facet labels", () => {
  test("retains a controlled selection label after later results omit it", () => {
    const selected = ["user-1"];
    const resolved = rememberSelectedFacetLabels(
      {},
      selected,
      new Map([["user-1", "Ada Lovelace"]]),
    );

    expect(rememberSelectedFacetLabels(resolved, selected, new Map())).toEqual({
      "user-1": "Ada Lovelace",
    });
  });
});

describe("document routes", () => {
  test("re-resolves a live search file immediately before navigation", async () => {
    expect(
      await resolveEntityDocumentRoute({
        hit: {
          entityId: "entity-1",
          fileFieldId: "stale-field",
          workspaceId: "workspace-1",
        },
        resolveCurrentFileFieldId: async () => "current-field",
      }),
    ).toEqual({
      fileFieldId: "current-field",
      route: {
        to: "/workspaces/$workspaceId/$viewId/document",
        params: { workspaceId: "workspace-1", viewId: "all" },
        search: { entity: "entity-1", field: "current-field" },
      },
    });
  });

  test("opens the all view when current resolution finds no file field", async () => {
    expect(
      await resolveEntityDocumentRoute({
        hit: {
          entityId: "entity-1",
          fileFieldId: "stale-field",
          workspaceId: "workspace-1",
        },
        resolveCurrentFileFieldId: async () => null,
      }),
    ).toEqual({
      fileFieldId: null,
      route: {
        to: "/workspaces/$workspaceId/$viewId",
        params: { workspaceId: "workspace-1", viewId: "all" },
      },
    });
  });

  test("reveals a modifier-activated entity hit in its file tree", () => {
    const documentHit = getRecentFilePreviewHit({
      entityId: "entity-1",
      openedAt: "2026-07-31T05:00:00.000Z",
      title: "Disclosure.pdf",
      workspaceId: "workspace-1",
      workspaceName: "Disclosure review",
    });

    expect(getEntityLocation({ ...documentHit, parentId: "folder-1" })).toEqual(
      {
        type: "tree",
        workspaceId: "workspace-1",
        entityId: "entity-1",
        fallbackFolderId: "folder-1",
      },
    );
    // Matter-root entities carry no folder scope.
    expect(getEntityLocation(documentHit)).toEqual({
      type: "tree",
      workspaceId: "workspace-1",
      entityId: "entity-1",
      fallbackFolderId: null,
    });
    // Hits without a containing matter location keep their normal open.
    expect(
      getEntityLocation(chatHit({ threadId: "thread-1", workspaceId: null })),
    ).toBeNull();
  });

  test("opens a task's matter, since the file tree lists no tasks", () => {
    const entityHit = getRecentFilePreviewHit({
      entityId: "subtask-1",
      openedAt: "2026-07-31T05:00:00.000Z",
      title: "File the reply",
      workspaceId: "workspace-1",
      workspaceName: "Disclosure review",
    });

    // A subtask's parent is another task, equally absent from the tree.
    expect(
      getEntityLocation({ ...entityHit, type: "task", parentId: "task-1" }),
    ).toEqual({ type: "matter", workspaceId: "workspace-1" });
  });

  test("opens a recent file directly when its field id was persisted", () => {
    expect(
      getRecentFileRoute({
        entityId: "entity-1",
        fileFieldId: "field-1",
        workspaceId: "workspace-1",
      }),
    ).toEqual({
      to: "/workspaces/$workspaceId/$viewId/document",
      params: { workspaceId: "workspace-1", viewId: "all" },
      search: { entity: "entity-1", field: "field-1" },
    });
  });

  test("locates a recent file by its own tree row", () => {
    expect(
      getRecentFileLocation({
        entityId: "entity-1",
        workspaceId: "workspace-1",
      }),
    ).toEqual({
      type: "tree",
      workspaceId: "workspace-1",
      entityId: "entity-1",
      fallbackFolderId: null,
    });
  });
});

describe("recent file previews", () => {
  test("reuses stored file metadata as a native document search hit", () => {
    const resource = resourceRef({
      type: RESOURCE_TYPE.ENTITY,
      id: toSafeId<"entity">("entity-1"),
    });
    expect(
      getRecentFilePreviewHit({
        entityId: "entity-1",
        fileFieldId: "field-1",
        filePropertyId: "property-1",
        mimeType: "application/pdf",
        openedAt: "2026-07-31T05:00:00.000Z",
        title: "Disclosure.pdf",
        updatedAt: "2021-03-15T10:00:00.000Z",
        workspaceId: "workspace-1",
        workspaceName: "Disclosure review",
      }),
    ).toEqual({
      entityId: "entity-1",
      fileFieldId: "field-1",
      filePropertyId: "property-1",
      headline: null,
      id: "document:entity-1",
      lastEditedByImage: null,
      lastEditedByName: null,
      mimeType: "application/pdf",
      parentId: null,
      resource,
      resourceName: toResourceName(resource),
      title: "Disclosure.pdf",
      type: "document",
      updatedAt: "2021-03-15T10:00:00.000Z",
      workspaceId: "workspace-1",
      workspaceName: "Disclosure review",
    });
  });

  test("omits dates for legacy recents that only store the open timestamp", () => {
    expect(
      getRecentFilePreviewDateVisibility({
        entityId: "entity-1",
        openedAt: "2026-07-31T05:00:00.000Z",
        title: "Disclosure.pdf",
        workspaceId: "workspace-1",
        workspaceName: "Disclosure review",
      }),
    ).toBe("hide");
  });

  test("shows the persisted document update timestamp", () => {
    expect(
      getRecentFilePreviewDateVisibility({
        entityId: "entity-1",
        openedAt: "2026-07-31T05:00:00.000Z",
        title: "Disclosure.pdf",
        updatedAt: "2021-03-15T10:00:00.000Z",
        workspaceId: "workspace-1",
        workspaceName: "Disclosure review",
      }),
    ).toBe("show");
  });
});

describe("toAskAIMessageHtml", () => {
  test("escapes markup-significant characters so the query stays literal text", () => {
    const query = "liability cap < 5% & indemnity <b>scope</b>";
    expect(toAskAIMessageHtml(query)).not.toBe(query);
    expect(toAskAIMessageHtml(query)).toBe(
      "liability cap &lt; 5% &amp; indemnity &lt;b&gt;scope&lt;/b&gt;",
    );
  });

  test("leaves plain queries untouched", () => {
    expect(toAskAIMessageHtml("smluvní pokuta")).toBe("smluvní pokuta");
  });
});

describe("Ask AI keyboard shortcut", () => {
  test("is available only while browsing", () => {
    expect(
      canUseAskAIShortcut({
        canAskAI: true,
        mode: "browse",
        query: "indemnity",
      }),
    ).toBe(true);
    expect(
      canUseAskAIShortcut({
        canAskAI: true,
        mode: "pick",
        query: "indemnity",
      }),
    ).toBe(false);
  });
});
