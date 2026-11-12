import { describe, expect, test } from "bun:test";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";

import { needsConsent } from "./api-request";
import {
  addMatterMember,
  addMatterParty,
  archiveMatter,
  deleteMatter,
  duplicateMatter,
  listMatterParties,
  matterChangeBody,
  readMatter,
  removeMatterMember,
  removeMatterParty,
  unarchiveMatter,
  updateMatter,
} from "./matter-detail";

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
  readonly route: string;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
};

/** A server answering every API call with `respond`, recording each call. */
const server = (respond: (call: Call) => Response) => {
  const calls: Call[] = [];
  const fetch: Fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const call = {
      route: `${init?.method ?? "GET"} ${input.replace(SESSION.serverUrl, "")}`,
      idempotencyKey: headers.get("idempotency-key"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  };
  const store = createSessionStore({
    read: async () => SESSION,
    write: async () => {},
    prepareClear: async () => {},
    clear: async () => {},
  });
  const source = createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    generation: store.generation(),
    store,
  });
  return { calls, request: { fetch, matterId: "matter/1", source } };
};

const MATTER = {
  id: "matter/1",
  name: "Harbor lease renewal",
  reference: "2026/014",
  color: null,
  status: "active",
  leadUserId: null,
  clientId: "contact-1",
  client: {
    id: "contact-1",
    type: "organization",
    displayName: "Harbor Holdings",
    color: null,
  },
  stampedVersionCount: 2,
  organizationId: "org-1",
};

describe("reading a matter", () => {
  test("reads its own route and keeps what the info screen shows", async () => {
    const { calls, request } = server(() => Response.json(MATTER));
    const read = await readMatter(request);
    expect(read.isOk() ? read.value : read.error).toEqual({
      id: "matter/1",
      name: "Harbor lease renewal",
      reference: "2026/014",
      color: null,
      status: "active",
      leadUserId: null,
      client: {
        id: "contact-1",
        type: "organization",
        displayName: "Harbor Holdings",
      },
      stampedVersionCount: 2,
    });
    expect(calls.map(({ route }) => route)).toEqual([
      "GET /v1/workspaces/matter%2F1",
    ]);
  });

  test("a status this build does not know is an error, not a guess", async () => {
    const { request } = server(() =>
      Response.json({ ...MATTER, status: "frozen" }),
    );
    const read = await readMatter(request);
    expect(read.isErr() ? read.error._tag : read.value).toBe("ApiRequestError");
  });
});

describe("changing a matter", () => {
  test("each change sends only its own field", () => {
    expect(matterChangeBody({ type: "name", value: "Lease" })).toEqual({
      name: "Lease",
    });
    expect(matterChangeBody({ type: "reference", value: "2026/015" })).toEqual({
      reference: "2026/015",
    });
    expect(matterChangeBody({ type: "leadUserId", value: null })).toEqual({
      leadUserId: null,
    });
  });

  test("a new client names the one it replaces, null for a personal matter", () => {
    expect(
      matterChangeBody({
        type: "clientId",
        value: "contact-2",
        expectedClientId: null,
      }),
    ).toEqual({ clientId: "contact-2", expectedClientId: null });
  });

  test("goes to the matter's own route", async () => {
    const { calls, request } = server(() => Response.json({}));
    const updated = await updateMatter({
      ...request,
      change: { type: "name", value: "Lease" },
    });
    expect(updated.isOk()).toBe(true);
    expect(calls).toEqual([
      {
        route: "POST /v1/workspaces/matter%2F1",
        idempotencyKey: null,
        body: { name: "Lease" },
      },
    ]);
  });

  test("a sign-in from before the app asked for the scope asks for consent", async () => {
    const { request } = server(
      () =>
        new Response(null, {
          status: 403,
          headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope"' },
        }),
    );
    const added = await addMatterMember({ ...request, userId: "user-2" });
    expect(added.isErr() && needsConsent(added.error)).toBe(true);
  });

  test("a refusal keeps the server's reason for the notice", async () => {
    const { request } = server(() =>
      Response.json(
        { message: "Cannot remove the last member" },
        { status: 400 },
      ),
    );
    const removed = await removeMatterMember({ ...request, userId: "user-1" });
    expect(
      removed.isErr() && removed.error._tag === "ApiRequestError"
        ? removed.error.detail
        : undefined,
    ).toBe("Cannot remove the last member");
  });
});

describe("the whole matter", () => {
  test("archive, unarchive, duplicate and delete use the web's routes", async () => {
    const { calls, request } = server(({ route }) =>
      route.endsWith("/duplicate")
        ? Response.json({ workspaceId: "matter-2" })
        : Response.json({ success: true }),
    );
    await archiveMatter(request);
    await unarchiveMatter(request);
    const copy = await duplicateMatter({ ...request, includeContent: true });
    await deleteMatter(request);
    expect(copy.isOk() ? copy.value : copy.error).toBe("matter-2");
    expect(calls).toEqual([
      {
        route: "POST /v1/workspaces/matter%2F1/archive",
        idempotencyKey: null,
        body: {},
      },
      {
        route: "POST /v1/workspaces/matter%2F1/unarchive",
        idempotencyKey: null,
        body: {},
      },
      {
        route: "POST /v1/workspaces/matter%2F1/duplicate",
        idempotencyKey: null,
        body: { includeContent: true },
      },
      {
        route: "DELETE /v1/workspaces/matter%2F1",
        idempotencyKey: null,
        body: undefined,
      },
    ]);
  });
});

describe("members and parties", () => {
  test("a member goes on by id and comes off by their own route", async () => {
    const { calls, request } = server(() => Response.json({ id: "row-1" }));
    await addMatterMember({ ...request, userId: "user-2" });
    await removeMatterMember({ ...request, userId: "user-2" });
    expect(calls.map(({ route, body }) => [route, body])).toEqual([
      ["PUT /v1/workspaces/matter%2F1/members", { userId: "user-2" }],
      ["DELETE /v1/workspaces/matter%2F1/members/user-2", undefined],
    ]);
  });

  test("a party is linked once under its request id, and unlinked by its link", async () => {
    const { calls, request } = server(() => Response.json({ id: "link-1" }));
    await addMatterParty({
      ...request,
      contactId: "contact-9",
      requestId: "request-1",
      role: "opposing_party",
    });
    await removeMatterParty({ ...request, partyId: "link-1" });
    expect(calls).toEqual([
      {
        route: "PUT /v1/workspaces/matter%2F1/contacts",
        idempotencyKey: "request-1",
        body: { contactId: "contact-9", role: "opposing_party" },
      },
      {
        route: "DELETE /v1/workspaces/matter%2F1/contacts/link-1",
        idempotencyKey: null,
        body: undefined,
      },
    ]);
  });

  test("the parties list keeps each contact in its role", async () => {
    const { request } = server(() =>
      Response.json({
        contacts: [
          {
            id: "link-1",
            workspaceId: "matter/1",
            contactId: "contact-9",
            role: "judge",
            isPrimary: false,
            notes: null,
            contact: {
              id: "contact-9",
              type: "person",
              displayName: "Judge Novák",
              color: null,
            },
          },
        ],
        overflow: false,
      }),
    );
    const parties = await listMatterParties(request);
    expect(parties.isOk() ? parties.value : parties.error).toEqual([
      {
        id: "link-1",
        role: "judge",
        contact: {
          id: "contact-9",
          type: "person",
          displayName: "Judge Novák",
        },
      },
    ]);
  });
});
