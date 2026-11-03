import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

const originalFetch = globalThis.fetch;
GlobalRegistrator.register({
  url: "http://localhost:3000/auth/error?error=account_not_linked",
});
// Auth plugins subscribe to session state during initialization. Keep those
// background reads inside the fake transport until the DOM has closed.
const backgroundFetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
globalThis.fetch = backgroundFetch;
const { loadSocialLinkHint, NO_SOCIAL_LINK_HINT } =
  await import("./social-link-hint");

afterEach(() => {
  globalThis.fetch = backgroundFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
  globalThis.fetch = originalFetch;
});

const respond = (reply: () => Promise<Response>) => {
  const paths: string[] = [];
  const contentTypes: (string | null)[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      paths.push(
        new URL(
          input instanceof Request ? input.url : String(input),
          window.location.origin,
        ).pathname,
      );
      contentTypes.push(
        new Headers(
          input instanceof Request ? input.headers : init?.headers,
        ).get("content-type"),
      );
      return await reply();
    },
    { preconnect: () => undefined },
  );
  return Object.assign(paths, { contentTypes });
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

test("the hint is requested as JSON on a page with a query string", async () => {
  const requests = respond(async () =>
    Response.json({ method: null, provider: null }),
  );
  await load();
  expect(requests.contentTypes).toEqual(["application/json"]);
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
