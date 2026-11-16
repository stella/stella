import { describe, expect, test } from "bun:test";

import type { PermissionInput } from "@stll/permissions/role-grants";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";

import { readMyRole, roleCan } from "./role";

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

/** A server answering every API call with `respond`, recording each route. */
const server = (respond: () => Response) => {
  const routes: string[] = [];
  const fetch: Fetch = async (input, init) => {
    routes.push(
      `${init?.method ?? "GET"} ${input.replace(SESSION.serverUrl, "")}`,
    );
    return respond();
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
  return { fetch, routes, source };
};

describe("the person's role", () => {
  test("is read from its own route", async () => {
    const { fetch, routes, source } = server(() =>
      Response.json({ role: "intern" }),
    );
    const read = await readMyRole({ fetch, source });
    expect(read.isOk() ? read.value : read.error).toBe("intern");
    expect(routes).toEqual(["GET /v1/me/role"]);
  });

  test("an answer without a role is an error, not a guess", async () => {
    const { fetch, source } = server(() => Response.json({ role: "" }));
    const read = await readMyRole({ fetch, source });
    expect(read.isErr() ? read.error._tag : read.value).toBe("ApiRequestError");
  });
});

describe("what a role may do", () => {
  test("a member edits and deletes matters and tasks; an intern or external only reads", () => {
    const edits: PermissionInput[] = [
      { workspace: ["update"] },
      { workspace: ["delete"] },
      { entity: ["update"] },
      { entity: ["delete"] },
    ];
    for (const permissions of edits) {
      expect(roleCan("member", permissions)).toBe(true);
      expect(roleCan("intern", permissions)).toBe(false);
      expect(roleCan("external", permissions)).toBe(false);
    }
    expect(roleCan("external", { workspace: ["read"] })).toBe(true);
  });

  test("a role not read yet allows nothing", () => {
    expect(roleCan(null, { workspace: ["read"] })).toBe(false);
  });
});
