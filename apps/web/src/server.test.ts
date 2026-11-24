import { createElement } from "react";

import type * as StartServerExports from "@tanstack/react-start/server";
import type { ServerEntry } from "@tanstack/react-start/server-entry";
import { expect, mock, test } from "bun:test";

import { assertSsrDocument } from "@stll/ssr-testkit";

import {
  ANONYMOUS_DOCUMENT_CACHE_CONTROL,
  ROUTE_CACHE_CLASSES,
  SSR_CACHE_CLASS_HEADER,
} from "@/route-response-policy";
import { SSR_STATUS_HEADER } from "@/ssr-response-status";

const PUBLIC_POLICY = "public, max-age=300";
const DOCUMENT_POLICY = "private, no-store";
const HTML =
  "<html><head><title>stella</title></head><body><main>Catalogue</main></body></html>";
const REDIRECT_LOCATION = "/auth";
const STATUS_TEXT = "Fixture response";

const fixtureHandler = {
  fetch: async (request: Request) => {
    const url = new URL(request.url);
    const headers = new Headers({ "Cache-Control": PUBLIC_POLICY });
    const cacheClass = url.searchParams.get("class");
    if (cacheClass !== null) {
      headers.set(SSR_CACHE_CLASS_HEADER, cacheClass);
    }
    const contentType = url.searchParams.get("type");
    if (contentType !== null) {
      headers.set("Content-Type", contentType);
    }
    const status = Number(url.searchParams.get("status") ?? 200);
    if (status === 302) {
      headers.set("Location", REDIRECT_LOCATION);
    }
    const requestedStatus = url.searchParams.get("documentStatus");
    if (requestedStatus !== null) {
      headers.set(SSR_STATUS_HEADER, requestedStatus);
    }
    if (url.searchParams.get("policy") === "absent") {
      headers.delete("Cache-Control");
    }
    if (url.searchParams.get("cookie") === "set") {
      headers.set("Set-Cookie", "fixture=1; Path=/");
    }
    return await Promise.resolve(
      new Response(HTML, { headers, status, statusText: STATUS_TEXT }),
    );
  },
};
await mock.module("@tanstack/react-start/server-entry", () => ({
  createServerEntry: (entry: ServerEntry) => entry,
  default: fixtureHandler,
}));
const startServer = await import("@tanstack/react-start/server");
await mock.module(
  "@tanstack/react-start/server",
  () =>
    ({
      ...startServer,
      createStartHandler: () => fixtureHandler.fetch,
      StartServer: () => createElement("div"),
    }) satisfies Pick<
      typeof StartServerExports,
      "createStartHandler" | "StartServer"
    >,
);
const { default: server } = await import("@/server");

test("invoice link documents are not cached and never send a referrer", async () => {
  const response = await server.fetch(
    new Request("https://stella.test/invoice-link?type=text/html"),
  );
  expect(response.headers.get("Cache-Control")).toBe(DOCUMENT_POLICY);
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  await response.text();
});

const cacheClasses = [...new Set(Object.values(ROUTE_CACHE_CLASSES))];
const mediaTypes = [
  null,
  "text/html",
  "Text/HTML ; charset=UTF-8",
  "application/json",
  "application/xml",
];
const statuses = [200, 302, 404, 500, 503];

const expectedCacheControl = ({
  sharedDocument,
  sharedResource,
}: {
  sharedDocument: boolean;
  sharedResource: boolean;
}) => {
  if (sharedDocument) {
    return ANONYMOUS_DOCUMENT_CACHE_CONTROL;
  }
  return sharedResource ? PUBLIC_POLICY : DOCUMENT_POLICY;
};

const viewers = [
  ["anonymous", {}],
  ["with a session cookie", { Cookie: "session=fixture" }],
  ["with an authorization header", { Authorization: "Bearer fixture" }],
] as const;

for (const cacheClass of [null, ...cacheClasses]) {
  for (const contentType of mediaTypes) {
    for (const status of statuses) {
      for (const [viewer, requestHeaders] of viewers) {
        test(`response policy: ${cacheClass ?? "default"}, ${contentType ?? "unspecified"}, ${status}, ${viewer}`, async () => {
          const url = new URL("https://stella.test/law");
          if (cacheClass !== null) {
            url.searchParams.set("class", cacheClass);
          }
          if (contentType !== null) {
            url.searchParams.set("type", contentType);
          }
          url.searchParams.set("status", String(status));
          const response = await server.fetch(
            new Request(url, { headers: requestHeaders }),
          );
          const successful = status === 200;
          const html =
            contentType?.toLowerCase().startsWith("text/html") ?? false;
          const sharedDocument =
            cacheClass === "public-indexable" &&
            successful &&
            html &&
            viewer === "anonymous";
          const sharedResource =
            cacheClass === "public-anonymous" && successful && !html;
          expect(response.headers.get("Cache-Control")).toBe(
            expectedCacheControl({ sharedDocument, sharedResource }),
          );
          expect(response.headers.get("Vary")).toBe(
            sharedDocument ? "Accept-Language, Cookie" : null,
          );
          expect(response.headers.get("X-Robots-Tag")).toBe(
            cacheClass === "public-indexable" && successful && html
              ? null
              : "noindex",
          );
          expect(response.headers.get(SSR_CACHE_CLASS_HEADER)).toBeNull();
          expect(response.headers.get(SSR_STATUS_HEADER)).toBeNull();
          expect(response.status).toBe(status);
          expect(response.statusText).toBe(STATUS_TEXT);
          expect(response.headers.get("Location")).toBe(
            status === 302 ? REDIRECT_LOCATION : null,
          );
          expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe(
            "same-origin",
          );
          expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe(
            "credentialless",
          );
          // Only a document a shared cache may store drops the nonce.
          const scriptPolicy = response.headers
            .get("Content-Security-Policy")
            ?.split("; ")
            .find((directive) => directive.startsWith("script-src "));
          if (!html) {
            expect(scriptPolicy).toBeUndefined();
          } else if (sharedDocument) {
            expect(scriptPolicy).toStartWith("script-src 'self' ");
            expect(scriptPolicy).not.toContain("'nonce-");
            expect(scriptPolicy).not.toContain("'strict-dynamic'");
          } else {
            expect(scriptPolicy).toMatch(
              /^script-src 'self' 'nonce-[^']+' 'strict-dynamic' /u,
            );
          }
          const document = await response.text();
          if (html) {
            assertSsrDocument({
              contentType: response.headers.get("Content-Type"),
              html: document,
              requiredContent: ["<main>Catalogue</main>"],
              status: response.status,
              expectedStatus: status,
            });
          }
          expect(document).toBe(HTML);
        });
      }
    }
  }
}

test("a response that sets a cookie is never shared", async () => {
  for (const [cacheClass, type] of [
    ["public-indexable", "text/html"],
    ["public-anonymous", "application/xml"],
  ] as const) {
    const url = new URL("https://stella.test/law");
    url.searchParams.set("class", cacheClass);
    url.searchParams.set("type", type);
    url.searchParams.set("cookie", "set");
    const response = await server.fetch(new Request(url));
    expect(response.headers.get("Cache-Control")).toBe(DOCUMENT_POLICY);
    expect(response.headers.get("Vary")).toBeNull();
    await response.text();
  }
});

test("document status determines the final response policy", async () => {
  for (const cacheClass of cacheClasses) {
    const url = new URL("https://stella.test/law");
    url.searchParams.set("type", "text/html");
    url.searchParams.set("class", cacheClass);
    url.searchParams.set("documentStatus", "503");
    const response = await server.fetch(new Request(url));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe(DOCUMENT_POLICY);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(response.headers.get(SSR_STATUS_HEADER)).toBeNull();
    // An unread SSR body keeps its lifetime timer; release it with the test.
    await response.body?.cancel();
  }
});

test("a public response requires an explicit freshness policy", async () => {
  const response = await server.fetch(
    new Request(
      "https://stella.test/sitemap.xml?class=public-anonymous&policy=absent&type=application/xml",
    ),
  );
  expect(response.headers.get("Cache-Control")).toBe(DOCUMENT_POLICY);
});

test("an unknown document path stays a direct 404 response", async () => {
  const { renderToString } = await import("react-dom/server");
  const {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
  } = await import("@tanstack/react-router");
  const { getSsrStatus } = await import("@tanstack/react-router/ssr/server");
  const { IntlProvider } = await import("use-intl");
  const { DefaultNotFoundComponent } =
    await import("@/components/route-components");
  const { default: messages } = await import("@/i18n/langs/en.json");
  const root = createRootRoute();
  const router = createRouter({
    isServer: true,
    history: createMemoryHistory({ initialEntries: ["/time/invoices"] }),
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/workspaces" }),
    ]),
    defaultNotFoundComponent: () =>
      IntlProvider({
        children: createElement(DefaultNotFoundComponent),
        locale: "en",
        messages,
        timeZone: "UTC",
      }),
  });
  await router.load();
  const response = new Response(
    renderToString(createElement(RouterProvider, { router })),
    { status: getSsrStatus(router) },
  );

  expect(response.status).toBe(404);
  expect(response.headers.get("Location")).toBeNull();
  expect(await response.text()).toContain(
    "We could not find what you requested.",
  );
});
