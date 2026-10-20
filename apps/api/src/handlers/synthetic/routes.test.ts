import { expect, test } from "bun:test";
import Elysia from "elysia";

import { sha256Hex } from "@stll/sha256/bun";

import { getAuth } from "@/api/lib/auth";
import { initRequestContext } from "@/api/lib/observability/request-context";
import { answerRequestError } from "@/api/lib/observability/request-lifecycle";

import { createSyntheticRoute } from "./routes";

const key = `stl_syn_${"a".repeat(43)}`;
const nowMs = Date.parse("2026-10-19T12:00:00Z");
const notAfter = "2026-10-20T12:00:00Z";
const keys = [{ label: "current", sha256: sha256Hex(key), notAfter }];
const session = {
  cookieName: "session",
  cookieValue: "signed-cookie",
  expiresAt: new Date(nowMs + 30 * 60_000).toISOString(),
};
const mintRequest = (credential?: string) =>
  new Request("http://localhost/synthetic/session", {
    method: "POST",
    headers:
      credential === undefined
        ? {}
        : { "x-stella-synthetic-key": credential, "user-agent": "monitor" },
  });
const appFor = (options: Parameters<typeof createSyntheticRoute>[0]) =>
  new Elysia()
    .onRequest(({ request }) => initRequestContext(request))
    .onError(answerRequestError)
    .use(createSyntheticRoute(options))
    .mount(getAuth().handler);

test("configured credentials mint the session and preserve its expiry", async () => {
  const received: Parameters<
    Parameters<typeof createSyntheticRoute>[0]["mintSession"]
  >[0][] = [];
  const app = appFor({
    keys,
    nowMs: () => nowMs,
    reserveBudget: async () => true,
    mintSession: async (metadata) => {
      received.push(metadata);
      return session;
    },
  });
  const response = await app.handle(mintRequest(key));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(session);
  expect(received).toEqual([
    {
      keyLabel: "current",
      requestId: expect.stringMatching(/^req_/u),
      userAgent: "monitor",
    },
  ]);
});

test("unavailable credentials have the same response as an unmounted route", async () => {
  const mintSession = async () => session;
  const unavailable = appFor({ keys: undefined, mintSession });
  const reference = await unavailable.handle(mintRequest());
  const expected = {
    status: reference.status,
    body: new Uint8Array(await reference.arrayBuffer()),
    contentType: reference.headers.get("content-type"),
  };
  expect(expected).toEqual({
    status: 404,
    body: new Uint8Array(),
    contentType: null,
  });
  const configured = appFor({
    keys,
    mintSession,
    reserveBudget: async () => true,
    nowMs: () => nowMs,
  });
  const expired = appFor({
    keys,
    mintSession,
    nowMs: () => Date.parse(notAfter),
  });
  for (const [app, credential] of [
    [configured, undefined],
    [configured, `stl_syn_${"b".repeat(43)}`],
    [configured, "malformed"],
    [expired, key],
    [unavailable, key],
  ] as const) {
    const response = await app.handle(mintRequest(credential));
    expect({
      status: response.status,
      body: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type"),
    }).toEqual(expected);
  }
});

test("the next configured credential is accepted during rotation", async () => {
  const next = `stl_syn_${"c".repeat(43)}`;
  const app = appFor({
    keys: [...keys, { label: "next", sha256: sha256Hex(next), notAfter }],
    nowMs: () => nowMs,
    reserveBudget: async () => true,
    mintSession: async ({ keyLabel }) => {
      expect(keyLabel).toBe("next");
      return session;
    },
  });
  expect((await app.handle(mintRequest(next))).status).toBe(200);
});

test("the session budget refuses requests before minting", async () => {
  const app = appFor({
    keys,
    nowMs: () => nowMs,
    reserveBudget: async () => false,
    mintSession: async () => {
      throw new TypeError("Unexpected mint");
    },
  });
  expect((await app.handle(mintRequest(key))).status).toBe(429);
});

test("disabled session controls return the unavailable response", async () => {
  const app = appFor({
    keys,
    nowMs: () => nowMs,
    reserveBudget: async () => true,
    mintSession: async () => null,
  });
  const response = await app.handle(mintRequest(key));
  const reference = await appFor({
    keys: undefined,
    mintSession: async () => null,
  }).handle(mintRequest(key));
  expect(response.status).toBe(reference.status);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    new Uint8Array(await reference.arrayBuffer()),
  );
  expect(response.headers.get("content-type")).toBe(
    reference.headers.get("content-type"),
  );
});

test("unavailable credentials ignore request body content", async () => {
  const app = appFor({
    keys,
    nowMs: () => nowMs,
    mintSession: async () => null,
  });
  const response = await app.handle(
    new Request("http://localhost/synthetic/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
  );
  const reference = await appFor({
    keys: undefined,
    mintSession: async () => null,
  }).handle(mintRequest());
  expect(response.status).toBe(reference.status);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    new Uint8Array(await reference.arrayBuffer()),
  );
  expect(response.headers.get("content-type")).toBe(
    reference.headers.get("content-type"),
  );
});

test("the session credential is read only from its dedicated header", async () => {
  const app = appFor({
    keys,
    nowMs: () => nowMs,
    mintSession: async () => {
      throw new TypeError("Unexpected mint");
    },
  });
  const response = await app.handle(
    new Request("http://localhost/synthetic/session", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    }),
  );
  expect(response.status).toBe(404);
});
