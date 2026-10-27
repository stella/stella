import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";
import { ApiRequestError } from "@/state/api-request";
import { readEntityDetail } from "@/state/entity-detail";

import {
  appendEntityPage,
  applyEntityPage,
  EMPTY_ENTITIES_LOAD,
  ENTITY_PAGE_SIZE,
  entitySections,
  listMatterEntities,
  type MatterEntity,
} from "./matter-entities";

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  refreshToken: "refresh-1",
};

const row = (entityId: string, kind: string): MatterEntity => ({
  entityId,
  kind,
  name: `${kind} ${entityId}`,
  createdAt: "2026-10-20T09:30:00.000Z",
  updatedAt: null,
  status: null,
  createdBy: null,
});

type Call = { url: string; token: string; body: unknown };

/** A server whose API answers with `respond`, and whose token endpoint mints numbered tokens. */
const server = (respond: (call: Call) => Response) => {
  const calls: (Call | "token")[] = [];
  let minted = 0;
  const fetch: Fetch = async (input, init) => {
    if (input === SESSION.tokenEndpoint) {
      minted += 1;
      calls.push("token");
      return Response.json({
        access_token: `access-${minted}`,
        expires_in: 900,
        refresh_token: `refresh-${minted + 1}`,
        token_type: "Bearer",
      });
    }
    const token = (
      new Headers(init?.headers).get("authorization") ?? ""
    ).replace(/^Bearer /u, "");
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { url: input, token, body };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls };
};

const sourceFor = (fetch: Fetch) => {
  const store = createSessionStore({
    read: async () => SESSION,
    write: async () => {},
    clear: async () => {},
  });
  return createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    generation: store.generation(),
    store,
  });
};

describe("listing a matter's entities", () => {
  test("posts the page query and keeps the fields a row shows", async () => {
    const { fetch, calls } = server(() =>
      Response.json({
        items: [{ ...row("e1", "document"), fields: [], version: 3 }],
        limit: ENTITY_PAGE_SIZE,
        nextCursor: "next-1",
      }),
    );
    const result = await listMatterEntities({
      fetch,
      source: sourceFor(fetch),
      workspaceId: "matter 1",
      cursor: "cursor-0",
    });
    expect(result.isOk() ? result.value : result.error._tag).toEqual({
      items: [row("e1", "document")],
      nextCursor: "next-1",
    });
    expect(calls).toEqual([
      {
        url: "https://stella.example.com/v1/entities/matter%201/query",
        token: "access-0",
        body: {
          limit: ENTITY_PAGE_SIZE,
          excludedKinds: ["message", "link"],
          fieldMode: "visible",
          fieldIds: [],
          cursor: "cursor-0",
        },
      },
    ]);
  });

  test("the first page carries no cursor", async () => {
    const { fetch, calls } = server(() =>
      Response.json({ items: [], limit: 50, nextCursor: null }),
    );
    await listMatterEntities({
      fetch,
      source: sourceFor(fetch),
      workspaceId: "m",
      cursor: null,
    });
    const [call] = calls;
    expect(call !== "token" && call?.body).not.toHaveProperty("cursor");
  });

  test("a rejected token is replaced once, then the server's answer stands", async () => {
    const refused = server(() => new Response(null, { status: 401 }));
    const result = await listMatterEntities({
      fetch: refused.fetch,
      source: sourceFor(refused.fetch),
      workspaceId: "m",
      cursor: null,
    });
    expect(result.isErr() && result.error._tag).toBe("ApiRequestError");
    expect(refused.calls).toHaveLength(3);
    expect(refused.calls[1]).toBe("token");
  });

  test("a page in a shape this build cannot read is an error", async () => {
    const { fetch } = server(() => Response.json({ items: [{ id: 7 }] }));
    const result = await listMatterEntities({
      fetch,
      source: sourceFor(fetch),
      workspaceId: "m",
      cursor: null,
    });
    expect(result.isErr() && result.error._tag).toBe("ApiRequestError");
  });
});

describe("reading one entity", () => {
  test("gets the entity route and keeps what the sheet shows", async () => {
    const { fetch, calls } = server(() =>
      Response.json({
        entityId: "e1",
        kind: "document",
        name: "Lease.docx",
        currentVersionId: "v1",
        currentVersionCreatedAt: "2026-10-21T10:00:00.000Z",
        currentVersionReference: "2026/014-3",
        extractionFileFieldId: null,
        fields: [],
      }),
    );
    const result = await readEntityDetail({
      fetch,
      source: sourceFor(fetch),
      workspaceId: "m1",
      entityId: "e1",
    });
    expect(result.isOk() ? result.value : result.error._tag).toEqual({
      entityId: "e1",
      kind: "document",
      name: "Lease.docx",
      currentVersionCreatedAt: "2026-10-21T10:00:00.000Z",
      currentVersionReference: "2026/014-3",
    });
    expect(calls).toEqual([
      {
        url: "https://stella.example.com/v1/entities/m1/entity/e1",
        token: "access-0",
        body: undefined,
      },
    ]);
  });
});

describe("paging", () => {
  test("appends a page, keeping the first place of a repeated row", () => {
    expect(
      appendEntityPage([row("a", "document"), row("b", "task")], {
        items: [row("b", "task"), row("c", "folder")],
        nextCursor: null,
      }).map((entity) => entity.entityId),
    ).toEqual(["a", "b", "c"]);
  });

  test("a successful page moves the cursor and clears the last error", () => {
    const failed = {
      ...EMPTY_ENTITIES_LOAD,
      entities: [row("a", "document")],
      nextCursor: "c1",
      error: new ApiRequestError({ message: "offline" }),
    };
    expect(
      applyEntityPage(
        failed,
        Result.ok({ items: [row("b", "task")], nextCursor: null }),
        5,
      ),
    ).toEqual({
      loadedAt: 5,
      entities: [row("a", "document"), row("b", "task")],
      nextCursor: null,
      error: null,
    });
  });

  test("a failed page keeps the rows and cursor for a retry", () => {
    const loaded = {
      ...EMPTY_ENTITIES_LOAD,
      entities: [row("a", "document")],
      nextCursor: "c1",
    };
    const error = new ApiRequestError({ message: "offline" });
    expect(applyEntityPage(loaded, Result.err(error), 9)).toEqual({
      ...loaded,
      loadedAt: 9,
      error,
    });
  });
});

describe("sections", () => {
  test("documents with folders first, then tasks, in server order; unknown kinds and empty sections left out", () => {
    const sections = entitySections([
      row("d1", "document"),
      row("t1", "task"),
      row("f1", "folder"),
      row("x1", "signal"),
      row("d2", "document"),
    ]);
    expect(
      sections.map((section) => ({
        key: section.key,
        ids: section.data.map((entity) => entity.entityId),
      })),
    ).toEqual([
      { key: "documents", ids: ["f1", "d1", "d2"] },
      { key: "tasks", ids: ["t1"] },
    ]);
    expect(
      entitySections([row("t1", "task")]).map((section) => section.key),
    ).toEqual(["tasks"]);
  });
});
