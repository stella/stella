import { describe, expect, test } from "bun:test";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";

import { needsConsent } from "./api-request";
import { createContact, searchContacts } from "./contacts";
import type { ContactChoice } from "./contacts";

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

type Call = {
  readonly url: string;
  readonly method: string;
  readonly token: string;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
};

/** A server answering every API call with `respond`, minting numbered tokens. */
const server = (respond: (call: Call) => Response) => {
  const calls: Call[] = [];
  let minted = 0;
  const fetch: Fetch = async (input, init) => {
    if (input === SESSION.tokenEndpoint) {
      minted += 1;
      return Response.json({
        access_token: `access-${minted}`,
        expires_in: 900,
        refresh_token: `refresh-${minted + 1}`,
        token_type: "Bearer",
      });
    }
    const headers = new Headers(init?.headers);
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      token: (headers.get("authorization") ?? "").replace(/^Bearer /u, ""),
      idempotencyKey: headers.get("idempotency-key"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
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

const NOVAK: ContactChoice = {
  id: "contact-1",
  type: "person",
  displayName: "Jan Novák",
};

describe("finding a client", () => {
  test("asks the address book by name and keeps what the picker shows", async () => {
    const { fetch, calls } = server(() =>
      Response.json({
        items: [{ ...NOVAK, firstName: "Jan", emails: [], color: null }],
      }),
    );
    const found = await searchContacts({
      fetch,
      query: "  Novák s.r.o. ",
      source: sourceFor(fetch),
    });
    expect(found.isOk() ? found.value : found.error).toEqual([NOVAK]);
    expect(calls.map(({ url }) => url)).toEqual([
      "https://stella.example.com/v1/contacts/search?q=Nov%C3%A1k+s.r.o.",
    ]);
  });

  test("a blank query finds no one without asking", async () => {
    const { fetch, calls } = server(() => Response.json({ items: [NOVAK] }));
    const found = await searchContacts({
      fetch,
      query: "   ",
      source: sourceFor(fetch),
    });
    expect(found.isOk() ? found.value : found.error).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a contact of a kind this build does not know is an error, not a guess", async () => {
    const { fetch } = server(() =>
      Response.json({ items: [{ ...NOVAK, type: "court" }] }),
    );
    const found = await searchContacts({
      fetch,
      query: "Novák",
      source: sourceFor(fetch),
    });
    expect(found.isErr() ? found.error._tag : found.value).toBe(
      "ApiRequestError",
    );
  });
});

describe("adding a client to the address book", () => {
  test("puts the contact under one request id, repeated on a fresh token", async () => {
    const { fetch, calls } = server(({ token }) =>
      token === "access-0"
        ? new Response(null, { status: 401 })
        : Response.json(NOVAK, { status: 201 }),
    );
    const created = await createContact({
      displayName: " Jan Novák ",
      fetch,
      requestId: "request-1",
      source: sourceFor(fetch),
      type: "person",
    });
    expect(created.isOk() ? created.value : created.error).toEqual(NOVAK);
    expect(calls).toEqual([
      {
        url: "https://stella.example.com/v1/contacts",
        method: "PUT",
        token: "access-0",
        idempotencyKey: "request-1",
        body: { displayName: "Jan Novák", type: "person" },
      },
      {
        url: "https://stella.example.com/v1/contacts",
        method: "PUT",
        token: "access-1",
        idempotencyKey: "request-1",
        body: { displayName: "Jan Novák", type: "person" },
      },
    ]);
  });

  test("a sign-in from before the app asked for the contacts scope asks for consent", async () => {
    const { fetch } = server(
      () =>
        new Response(null, {
          status: 403,
          headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope"' },
        }),
    );
    const created = await createContact({
      displayName: "Harbor Holdings",
      fetch,
      requestId: "request-2",
      source: sourceFor(fetch),
      type: "organization",
    });
    expect(created.isErr() && needsConsent(created.error)).toBe(true);
  });
});
