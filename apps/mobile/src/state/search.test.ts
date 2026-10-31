import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  type StoredSession,
} from "@/connection/session";
import { ApiRequestError } from "@/state/api-request";

import {
  IDLE_SEARCH,
  NO_QUALIFIERS,
  plainHeadline,
  qualifierChips,
  SEARCH_PAGE_SIZE,
  searchRequestBody,
  searchResultRoute,
  searchStella,
  searchViewReducer,
  shownPage,
  toggleQualifier,
} from "./search";
import type { SearchPage, SearchResult, SearchView } from "./search";

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  refreshToken: "refresh-1",
  userId: "user-1",
};

const sourceFor = (fetch: Fetch) =>
  createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    store: {
      read: async () => SESSION,
      write: async () => {},
      clear: async () => {},
    },
  });

type Sent = { url: string; method: string; body: unknown };

const recording = (answer: unknown) => {
  const sent: Sent[] = [];
  const fetch: Fetch = async (input, init) => {
    sent.push({
      url: input,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Response.json(answer);
  };
  return { fetch, sent };
};

const UPDATED = "2026-10-01T09:00:00.000Z";

const documentResult: SearchResult = {
  kind: "entity",
  key: "entity:doc-1",
  entityKind: "document",
  entityId: "doc-1",
  workspaceId: "matter-1",
  matterName: "Matter One",
  title: "Lease agreement",
  updatedAt: UPDATED,
};

const pageOf = (results: readonly SearchResult[]): SearchPage => ({
  results,
  typeBuckets: [],
  matterBuckets: [],
});

describe("the search request", () => {
  test("sends the trimmed text, the picked matters and types, and empty filters it does not offer", () => {
    expect(
      searchRequestBody("  lease  ", {
        matterIds: ["matter-1"],
        types: ["document", "task"],
      }),
    ).toEqual({
      query: "lease",
      workspaceIds: ["matter-1"],
      types: ["document", "task"],
      kinds: [],
      editedByUserIds: [],
      mimeTypes: [],
      limit: SEARCH_PAGE_SIZE,
    });
  });

  test("never sends more text than the server reads", () => {
    expect(
      searchRequestBody("a".repeat(600), NO_QUALIFIERS).query,
    ).toHaveLength(500);
  });

  test("posts to the search route and keeps the hits the app can open", async () => {
    const { fetch, sent } = recording({
      hits: [
        {
          id: "entity:doc-1",
          type: "document",
          title: "Lease agreement",
          headline: "the <mark>lease</mark>",
          updatedAt: UPDATED,
          entityId: "doc-1",
          workspaceId: "matter-1",
          workspaceName: "Matter One",
          parentId: null,
        },
        {
          id: "matter:matter-2",
          type: "matter",
          title: "Matter Two",
          headline: null,
          updatedAt: UPDATED,
          workspaceId: "matter-2",
          workspaceName: "Matter Two",
        },
        {
          id: "chat:thread-1",
          type: "chat",
          title: "Notice period",
          headline: null,
          updatedAt: UPDATED,
          threadId: "thread-1",
          workspaceId: null,
          workspaceName: null,
        },
        {
          id: "case-law:decision-1",
          type: "case-law",
          title: "1 Abc 23/2024",
          headline: "a tenant&#x27;s <mark>lease</mark> &amp; deposit",
          updatedAt: UPDATED,
          decisionId: "decision-1",
          caseNumber: "1 Abc 23/2024",
          court: "Supreme Court",
          decisionDate: "2024-05-02",
        },
        {
          id: "contact:contact-1",
          type: "contact",
          title: "Sample Contact",
          headline: null,
          updatedAt: UPDATED,
          contactId: "contact-1",
        },
        {
          id: "future:1",
          type: "statute",
          title: "A kind this build does not know",
          headline: null,
          updatedAt: UPDATED,
        },
        {
          id: "entity:broken",
          type: "task",
          title: "A task without its matter",
          headline: null,
          updatedAt: UPDATED,
          entityId: "task-9",
        },
      ],
      facets: {
        type: [
          { value: "document", count: 1 },
          { value: "contact", count: 1 },
        ],
        workspace: [{ value: "matter-1", label: "Matter One", count: 1 }],
        editor: [],
        mimeType: [],
      },
      totalCount: 7,
      nextCursor: null,
    });
    const page = await searchStella({
      fetch,
      qualifiers: { matterIds: [], types: ["document"] },
      query: "lease",
      source: sourceFor(fetch),
    });

    expect(sent).toEqual([
      {
        url: "https://stella.example.com/v1/search",
        method: "POST",
        body: searchRequestBody("lease", {
          matterIds: [],
          types: ["document"],
        }),
      },
    ]);
    expect(page.isOk() ? page.value : null).toEqual({
      results: [
        documentResult,
        {
          kind: "matter",
          key: "matter:matter-2",
          workspaceId: "matter-2",
          title: "Matter Two",
          updatedAt: UPDATED,
        },
        {
          kind: "chat",
          key: "chat:thread-1",
          threadId: "thread-1",
          matterName: null,
          title: "Notice period",
          updatedAt: UPDATED,
        },
        {
          kind: "case-law",
          key: "case-law:decision-1",
          decisionId: "decision-1",
          caseNumber: "1 Abc 23/2024",
          court: "Supreme Court",
          decisionDate: "2024-05-02",
          preview: "a tenant's lease & deposit",
        },
      ],
      typeBuckets: [
        { value: "document", count: 1 },
        { value: "contact", count: 1 },
      ],
      matterBuckets: [{ value: "matter-1", label: "Matter One", count: 1 }],
    });
  });

  test("a page without facets, as a later page comes, has none to offer", async () => {
    const { fetch } = recording({ hits: [] });
    const page = await searchStella({
      fetch,
      qualifiers: NO_QUALIFIERS,
      query: "lease",
      source: sourceFor(fetch),
    });
    expect(page.isOk() ? page.value : null).toEqual(pageOf([]));
  });
});

describe("a headline", () => {
  test("loses its highlight tags and reads its escaped characters as text", () => {
    expect(
      plainHeadline("&lt;b&gt; <mark>Smith</mark> &quot;v&quot; &amp;amp;"),
    ).toBe('<b> Smith "v" &amp;');
  });
});

describe("where a result opens", () => {
  test("each kind opens the screen the app already has for it", () => {
    const entity = (entityKind: "folder" | "task" | "message" | "link") =>
      searchResultRoute({ ...documentResult, entityKind });

    expect(searchResultRoute(documentResult)).toEqual({
      pathname: "/document/[workspaceId]/[entityId]",
      params: {
        entityId: "doc-1",
        workspaceId: "matter-1",
        name: "Lease agreement",
      },
    });
    expect(entity("folder")).toEqual({
      pathname: "/matter/[workspaceId]",
      params: { workspaceId: "matter-1", name: "Matter One" },
    });
    for (const kind of ["task", "message", "link"] as const) {
      expect(entity(kind)).toEqual({
        pathname: "/matter/[workspaceId]/[entityId]",
        params: { entityId: "doc-1", workspaceId: "matter-1" },
      });
    }
    expect(
      searchResultRoute({
        kind: "matter",
        key: "matter:matter-2",
        workspaceId: "matter-2",
        title: "Matter Two",
        updatedAt: UPDATED,
      }),
    ).toEqual({
      pathname: "/matter/[workspaceId]",
      params: { workspaceId: "matter-2", name: "Matter Two" },
    });
    expect(
      searchResultRoute({
        kind: "chat",
        key: "chat:thread-1",
        threadId: "thread-1",
        matterName: null,
        title: "Notice period",
        updatedAt: UPDATED,
      }),
    ).toEqual({
      pathname: "/thread/[threadId]",
      params: { threadId: "thread-1" },
    });
    expect(
      searchResultRoute({
        kind: "case-law",
        key: "case-law:decision-1",
        decisionId: "decision-1",
        caseNumber: "1 Abc 23/2024",
        court: "Supreme Court",
        decisionDate: null,
        preview: null,
      }),
    ).toEqual({
      pathname: "/law/[decisionId]",
      params: { caseNumber: "1 Abc 23/2024", decisionId: "decision-1" },
    });
  });

  test("an untitled document opens without a name for the header", () => {
    expect(searchResultRoute({ ...documentResult, title: "" })).toEqual({
      pathname: "/document/[workspaceId]/[entityId]",
      params: { entityId: "doc-1", workspaceId: "matter-1" },
    });
  });
});

describe("the qualifier chips", () => {
  const facets = {
    typeBuckets: [
      { value: "document", count: 4 },
      { value: "contact", count: 2 },
      { value: "task", count: 1 },
    ],
    matterBuckets: [
      { value: "matter-1", label: "Matter One", count: 3 },
      { value: "matter-2", label: null, count: 1 },
      { value: "matter-3", label: "Matter Three", count: 1 },
    ],
  };

  test("offer the types the app can open and the named matters, before any is picked", () => {
    expect(qualifierChips(facets, NO_QUALIFIERS, new Map())).toEqual([
      { kind: "type", value: "document", picked: false },
      { kind: "type", value: "task", picked: false },
      { kind: "matter", value: "matter-1", label: "Matter One", picked: false },
      {
        kind: "matter",
        value: "matter-3",
        label: "Matter Three",
        picked: false,
      },
    ]);
  });

  test("put the picked ones first, once, named even when the page no longer lists them", () => {
    expect(
      qualifierChips(
        facets,
        { matterIds: ["matter-9", "matter-1"], types: ["task"] },
        new Map([["matter-9", "Matter Nine"]]),
      ),
    ).toEqual([
      { kind: "type", value: "task", picked: true },
      { kind: "matter", value: "matter-9", label: "Matter Nine", picked: true },
      { kind: "matter", value: "matter-1", label: "matter-1", picked: true },
      { kind: "type", value: "document", picked: false },
      {
        kind: "matter",
        value: "matter-3",
        label: "Matter Three",
        picked: false,
      },
    ]);
  });

  test("before any results load, only the picked ones show", () => {
    expect(
      qualifierChips(null, { matterIds: [], types: ["chat"] }, new Map()),
    ).toEqual([{ kind: "type", value: "chat", picked: true }]);
  });

  test("a tap picks a chip, and a second tap puts it back", () => {
    const type = { kind: "type", value: "document", picked: false } as const;
    const matter = {
      kind: "matter",
      value: "matter-1",
      label: "Matter One",
      picked: false,
    } as const;
    const picked = toggleQualifier(
      toggleQualifier(NO_QUALIFIERS, type),
      matter,
    );
    expect(picked).toEqual({ matterIds: ["matter-1"], types: ["document"] });
    expect(toggleQualifier(toggleQualifier(picked, type), matter)).toEqual(
      NO_QUALIFIERS,
    );
  });
});

describe("the latest search wins", () => {
  const first = pageOf([documentResult]);
  const second = pageOf([{ ...documentResult, key: "entity:doc-2" }]);

  test("an answer to a superseded search is dropped, the latest one's shows", () => {
    const steps: SearchView[] = [];
    let view = IDLE_SEARCH;
    for (const event of [
      { type: "start", ticket: 1 },
      { type: "start", ticket: 2 },
      { type: "answer", ticket: 1, result: Result.ok(first) },
      { type: "answer", ticket: 2, result: Result.ok(second) },
    ] as const) {
      view = searchViewReducer(view, event);
      steps.push(view);
    }
    expect(steps.map((step) => [step.status, step.ticket])).toEqual([
      ["loading", 1],
      ["loading", 2],
      ["loading", 2],
      ["loaded", 2],
    ]);
    expect(shownPage(view)).toBe(second);
  });

  test("a search cleared before its answer arrives stays cleared", () => {
    let view = searchViewReducer(IDLE_SEARCH, { type: "start", ticket: 1 });
    view = searchViewReducer(view, { type: "reset", ticket: 2 });
    view = searchViewReducer(view, {
      type: "answer",
      ticket: 1,
      result: Result.ok(first),
    });
    expect(view).toEqual({ status: "idle", ticket: 2 });
  });

  test("the results stay on screen while the next search loads", () => {
    let view = searchViewReducer(IDLE_SEARCH, { type: "start", ticket: 1 });
    view = searchViewReducer(view, {
      type: "answer",
      ticket: 1,
      result: Result.ok(first),
    });
    view = searchViewReducer(view, { type: "start", ticket: 2 });
    expect(view).toEqual({ status: "loading", ticket: 2, previous: first });
  });

  test("a failure of the latest search shows, and a repeated answer changes nothing", () => {
    const error = new ApiRequestError({ message: "offline" });
    let view = searchViewReducer(IDLE_SEARCH, { type: "start", ticket: 1 });
    view = searchViewReducer(view, {
      type: "answer",
      ticket: 1,
      result: Result.err(error),
    });
    expect(view).toEqual({ status: "failed", ticket: 1, error });
    expect(
      searchViewReducer(view, {
        type: "answer",
        ticket: 1,
        result: Result.ok(first),
      }),
    ).toBe(view);
  });
});
