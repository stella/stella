import { describe, expect, test } from "bun:test";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";

import { listMatters } from "./matters";

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  refreshToken: "refresh-1",
};

const MATTER = {
  id: "matter-1",
  name: "Novák v. Svoboda",
  reference: "2026/014",
  lastActivityAt: "2026-10-20T09:30:00.000Z",
  client: { displayName: "Novák" },
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

const sourceFor = (fetch: Fetch) =>
  createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    store: createSessionStore({
      read: async () => SESSION,
      write: async () => {},
      clear: async () => {},
    }),
  });

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
        client: { displayName: "Novák" },
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
    expect(await outcome(refused.fetch)).toBe("MattersRequestError");
    expect(refused.calls).toHaveLength(3);
  });

  test("a response in a shape this build cannot read is an error, not an empty list", async () => {
    const { fetch } = server(() => Response.json({ workspaces: [{ id: 7 }] }));
    expect(await outcome(fetch)).toBe("MattersRequestError");
  });
});
