import { describe, expect, test } from "bun:test";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";

import { needsConsent } from "./api-request";
import {
  createMatter,
  listMatters,
  listMemberCandidates,
  newMatterMembers,
} from "./matters";

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  signInId: "sign-in-1",
  refreshToken: "refresh-1",
  userId: "user-1",
};

const MATTER = {
  id: "matter-1",
  name: "Novák v. Svoboda",
  reference: "2026/014",
  lastActivityAt: "2026-10-20T09:30:00.000Z",
  client: { id: "contact-1", displayName: "Novák" },
  // Fields the app does not show ride along and are ignored.
  openTaskCount: 3,
};

/** A server whose matters route answers with `respond`, and whose token endpoint mints numbered tokens. */
const server = (respond: (token: string) => Response) => {
  const calls: string[] = [];
  let minted = 0;
  const fetch: Fetch = async (input, init) => {
    if (input === SESSION.tokenEndpoint) {
      minted += 1;
      calls.push(`token`);
      return Response.json({
        access_token: `access-${minted}`,
        expires_in: 900,
        refresh_token: `refresh-${minted + 1}`,
        token_type: "Bearer",
      });
    }
    const token = new Headers(init?.headers).get("authorization") ?? "";
    calls.push(`${input} ${token}`);
    return respond(token.replace(/^Bearer /u, ""));
  };
  return { fetch, calls };
};

const sourceFor = (fetch: Fetch) => {
  const store = createSessionStore({
    read: async () => SESSION,
    write: async () => {},
    prepareClear: async () => {},
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

const outcome = async (fetch: Fetch) => {
  const result = await listMatters({ fetch, source: sourceFor(fetch) });
  return result.isOk() ? result.value : result.error._tag;
};

describe("listing matters", () => {
  test("reads the REST route with the held token and keeps the fields it shows", async () => {
    const { fetch, calls } = server(() =>
      Response.json({ workspaces: [MATTER] }),
    );
    expect(await outcome(fetch)).toEqual([
      {
        id: "matter-1",
        name: "Novák v. Svoboda",
        reference: "2026/014",
        lastActivityAt: "2026-10-20T09:30:00.000Z",
        client: { id: "contact-1", displayName: "Novák" },
      },
    ]);
    expect(calls).toEqual([
      "https://stella.example.com/v1/workspaces Bearer access-0",
    ]);
  });

  test("a rejected token is replaced once, then the server's answer stands", async () => {
    const retried = server((token) =>
      token === "access-0"
        ? new Response(null, { status: 401 })
        : Response.json({ workspaces: [] }),
    );
    expect(await outcome(retried.fetch)).toEqual([]);
    expect(retried.calls).toEqual([
      "https://stella.example.com/v1/workspaces Bearer access-0",
      "token",
      "https://stella.example.com/v1/workspaces Bearer access-1",
    ]);

    const refused = server(() => new Response(null, { status: 401 }));
    expect(await outcome(refused.fetch)).toBe("ApiRequestError");
    expect(refused.calls).toHaveLength(3);
  });

  test("a response in a shape this build cannot read is an error, not an empty list", async () => {
    const { fetch } = server(() => Response.json({ workspaces: [{ id: 7 }] }));
    expect(await outcome(fetch)).toBe("ApiRequestError");
  });
});

describe("opening a matter", () => {
  test("puts the matter under the id the app named, with the web's documents column", async () => {
    const bodies: unknown[] = [];
    const { fetch, calls } = server(() => Response.json({ id: "matter-9" }));
    const recording: Fetch = async (input, init) => {
      if (init?.method === "PUT" && typeof init.body === "string") {
        bodies.push(JSON.parse(init.body));
      }
      return await fetch(input, init);
    };
    const created = await createMatter({
      clientId: null,
      fetch: recording,
      id: "matter-9",
      memberUserIds: ["user-2"],
      name: "Harbor lease renewal",
      source: sourceFor(recording),
    });
    expect(created.isOk() ? created.value : created.error).toBe("matter-9");
    expect(calls).toEqual([
      "https://stella.example.com/v1/workspaces Bearer access-0",
    ]);
    // Without a client the matter is personal: no one else is sent.
    expect(bodies).toEqual([
      {
        filePropertyName: "Documents",
        id: "matter-9",
        name: "Harbor lease renewal",
      },
    ]);
  });

  test("a client matter carries its client and the people it is shared with", async () => {
    const bodies: unknown[] = [];
    const { fetch } = server(() => Response.json({ id: "matter-9" }));
    const recording: Fetch = async (input, init) => {
      if (init?.method === "PUT" && typeof init.body === "string") {
        bodies.push(JSON.parse(init.body));
      }
      return await fetch(input, init);
    };
    const open = async (memberUserIds: readonly string[]) =>
      await createMatter({
        clientId: "contact-1",
        fetch: recording,
        id: "matter-9",
        memberUserIds,
        name: "Harbor lease renewal",
        source: sourceFor(recording),
      });
    await open(["user-2", "user-3"]);
    await open([]);
    expect(bodies).toEqual([
      {
        clientId: "contact-1",
        filePropertyName: "Documents",
        id: "matter-9",
        memberUserIds: ["user-2", "user-3"],
        name: "Harbor lease renewal",
      },
      {
        clientId: "contact-1",
        filePropertyName: "Documents",
        id: "matter-9",
        name: "Harbor lease renewal",
      },
    ]);
  });

  test("a sign-in without the write scope asks for consent", async () => {
    const { fetch } = server(
      () =>
        new Response(null, {
          status: 403,
          headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope"' },
        }),
    );
    const created = await createMatter({
      clientId: null,
      fetch,
      id: "matter-9",
      memberUserIds: [],
      name: "Harbor lease renewal",
      source: sourceFor(fetch),
    });
    expect(created.isErr() && needsConsent(created.error)).toBe(true);
  });
});

describe("who a new matter is shared with", () => {
  const chosen = new Set(["user-1", "user-2", "user-3"]);

  test("everyone chosen but the creator, who is on every matter they open", () => {
    expect(
      newMatterMembers({ chosen, clientId: "contact-1", creatorId: "user-1" }),
    ).toEqual(["user-2", "user-3"]);
  });

  test("no one on a personal matter, whoever was chosen before the client was cleared", () => {
    expect(
      newMatterMembers({ chosen, clientId: null, creatorId: "user-1" }),
    ).toEqual([]);
  });
});

describe("the people a matter can be shared with", () => {
  test("reads the organization's members from their own route", async () => {
    const { fetch, calls } = server(() =>
      Response.json({
        members: [
          {
            userId: "user-2",
            name: "Eva Dvořáková",
            email: "eva@example.com",
            image: null,
          },
        ],
      }),
    );
    const members = await listMemberCandidates({
      fetch,
      source: sourceFor(fetch),
    });
    expect(members.isOk() ? members.value : members.error).toEqual([
      {
        userId: "user-2",
        name: "Eva Dvořáková",
        email: "eva@example.com",
        image: null,
      },
    ]);
    expect(calls).toEqual([
      "https://stella.example.com/v1/workspaces/member-candidates Bearer access-0",
    ]);
  });
});
