import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/auth/error" });
const originalFetch = globalThis.fetch;
const { loadSocialLinkHint, NO_SOCIAL_LINK_HINT } =
  await import("./social-link-hint");

afterEach(() => {
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const respond = (reply: () => Promise<Response>) => {
  const paths: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      paths.push(
        new URL(
          input instanceof Request ? input.url : String(input),
          window.location.origin,
        ).pathname,
      );
      return await reply();
    },
    { preconnect: () => undefined },
  );
  return paths;
};
const load = async () => {
  const captured: unknown[] = [];
  const hint = await loadSocialLinkHint((error) => {
    captured.push(error);
  });
  return { captured, hint };
};

test("a valid hint is returned as sent", async () => {
  const paths = respond(async () =>
    Response.json({ method: "microsoft", provider: "google" }),
  );
  const { captured, hint } = await load();
  expect(hint).toEqual({ method: "microsoft", provider: "google" });
  expect(captured).toEqual([]);
  expect(
    paths.filter((path) => path.endsWith("/social-link-hint")),
  ).toHaveLength(1);
});

test("an unknown provider falls back to no hint", async () => {
  respond(async () => Response.json({ method: "myspace", provider: null }));
  const { captured, hint } = await load();
  expect(hint).toEqual(NO_SOCIAL_LINK_HINT);
  expect(captured).toEqual([]);
});

test("an error response is reported and falls back to no hint", async () => {
  respond(async () =>
    Response.json(
      { code: "INTERNAL_SERVER_ERROR", message: "unavailable" },
      { status: 500 },
    ),
  );
  const { captured, hint } = await load();
  expect(hint).toEqual(NO_SOCIAL_LINK_HINT);
  expect(captured).toHaveLength(1);
});

test("a rejected request is reported and falls back to no hint", async () => {
  respond(async () => await Promise.reject(new TypeError("network down")));
  const { captured, hint } = await load();
  expect(hint).toEqual(NO_SOCIAL_LINK_HINT);
  expect(captured).toHaveLength(1);
});
