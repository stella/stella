import { Suspense, use } from "react";

import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  HeadContent,
  Outlet,
  redirect,
  ScriptOnce,
  Scripts,
  useRouter,
} from "@tanstack/react-router";
import {
  createRequestHandler,
  RouterServer,
} from "@tanstack/react-router/ssr/server";
import { createServerEntry } from "@tanstack/react-start/server";
import { plugin } from "bun";
import { expect, mock, test } from "bun:test";

import { renderSsrResponse } from "../ssr-renderer";
import { unregisterDomEnvironment } from "../test-dom-environment";
import { withContentSecurityPolicy } from "./content-security-policy.server";

// This file renders documents on the server, where Start's build keeps the
// server half of each isomorphic function (the request nonce, the sidebar
// cookie). The test preload hands every other file the browser half; DOM test
// files run isolated, so replacing it here reaches no other file. Modules that
// build isomorphic functions are imported only after this replacement.
type IsomorphicHalf = (...args: never[]) => unknown;
await mock.module("@tanstack/start-fn-stubs", () => ({
  createClientOnlyFn: <Fn,>(fn: Fn) => fn,
  createServerOnlyFn: <Fn,>(fn: Fn) => fn,
  createIsomorphicFn: () => {
    let serverHalf: IsomorphicHalf = () => undefined;
    const isomorphic = Object.assign(
      (...args: never[]) => serverHalf(...args),
      {
        server: (half: IsomorphicHalf) => {
          serverHalf = half;
          return isomorphic;
        },
        client: () => isomorphic,
      },
    );
    return isomorphic;
  },
}));
const { getRequestSsrOptions } = await import("./ssr-options");

// Match the worker URL transform used by the application build.
plugin({
  name: "vite-worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});
Object.assign(import.meta.env, {
  SSR: true,
  DEV: false,
  VITE_DOCUMENTS_BUCKET: "documents",
  VITE_DOCUMENTS_ENDPOINT: "https://objects.stella.test",
  VITE_PUBLIC_TOOLS_ENABLED: "true",
  VITE_PUBLIC_KNOWLEDGE_ENABLED: "false",
});
// Unsplit client-only leaf modules read browser globals during import.
// Remove them before creating the router so the real render runs as SSR.
const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
GlobalRegistrator.register();
const { getRouter } = await import("../router");
await unregisterDomEnvironment();

const PENDING_TEXT = "Pending";
const SCRIPT_ONCE_SOURCE = "window.onceScript = true";

const environment = {
  apiBase: "https://stella.test/api",
  desktopBridgePort: 45_901,
  documentsBucket: "documents",
  documentsEndpoint: "https://objects.stella.test",
  sandboxUrl: "https://stella.test/sandbox",
};

// Serve as `server.ts` does: the server entry owns the request scope that
// Start's cookie and header helpers read, and the policy wraps the render.
const serveDocument = async (
  request: Request,
  fetchResponse: () => Promise<Response>,
): Promise<Response> =>
  await createServerEntry({
    fetch: async () =>
      await withContentSecurityPolicy({ environment, fetchResponse }),
  }).fetch(request);

const assertInlineScriptNonces = async (response: Response, html: string) => {
  const nonce =
    /'nonce-([^']+)'/u
      .exec(response.headers.get("Content-Security-Policy") ?? "")
      ?.at(1) ?? null;
  expect(nonce).toBeTruthy();
  const inlineNonces: (string | null)[] = [];
  await new HTMLRewriter()
    .on("script", {
      element: (element) => {
        if (!element.hasAttribute("src")) {
          inlineNonces.push(element.getAttribute("nonce"));
        }
      },
    })
    .transform(new Response(html))
    .text();
  expect(inlineNonces.length).toBeGreaterThan(0);
  expect(
    inlineNonces,
    "all inline SSR script nonces match the CSP header",
  ).toEqual(inlineNonces.map(() => nonce));
  return inlineNonces;
};

for (const pathname of ["/public", "/authenticated"]) {
  test(`${pathname}: every inline script in the SSR stream carries the response nonce`, async () => {
    const pending = Promise.withResolvers<string>();
    const errors: unknown[] = [];
    const request = new Request(`https://stella.test${pathname}`, {
      headers: {
        cookie: pathname === "/authenticated" ? "session=fixture" : "",
      },
    });
    const root = createRootRouteWithContext<{ session: string | null }>()({
      component: () => (
        <html lang="en">
          <head>
            <HeadContent />
          </head>
          <body>
            <Outlet />
            <Scripts />
          </body>
        </html>
      ),
    });
    const Page = () => (
      <main>
        <script nonce={useRouter().options.ssr?.nonce}>
          {"window.manualScript = true"}
        </script>
        <ScriptOnce>{SCRIPT_ONCE_SOURCE}</ScriptOnce>
        <Suspense fallback={<p>{PENDING_TEXT}</p>}>
          <Deferred />
        </Suspense>
      </main>
    );
    const Deferred = () => <p>{use(pending.promise)}</p>;
    const publicRoute = createRoute({
      getParentRoute: () => root,
      path: "/public",
      loader: () => ({ streamed: pending.promise }),
      component: Page,
    });
    const authenticatedRoute = createRoute({
      getParentRoute: () => root,
      path: "/authenticated",
      beforeLoad: ({ context }) => {
        if (context.session === null) {
          throw redirect({ href: "/auth" });
        }
      },
      loader: () => ({ streamed: pending.promise }),
      component: Page,
    });
    const response = await serveDocument(
      request,
      async () =>
        await createRequestHandler({
          request,
          createRouter: () =>
            createRouter({
              routeTree: root.addChildren([publicRoute, authenticatedRoute]),
              // Only the session boundary is a fixture; Router owns loading,
              // dehydration, script generation and stream transformation.
              context: {
                session: request.headers
                  .get("cookie")
                  ?.includes("session=fixture")
                  ? "fixture"
                  : null,
              },
              isServer: true,
              ssr: getRequestSsrOptions(),
            }),
        })(async ({ router, responseHeaders }) => {
          const rendered = await renderSsrResponse({
            request,
            rendererSignal: request.signal,
            router,
            responseHeaders,
            children: <RouterServer router={router} />,
            reportError: (error) => {
              errors.push(error);
            },
          });
          if (rendered.isErr()) {
            throw rendered.error;
          }
          return rendered.value;
        }),
    );
    expect(response.status).toBe(200);
    const body = response.body;
    if (body === null) {
      throw new TypeError("SSR response body missing");
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    while (!html.includes("<p>Pending</p>")) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      html += decoder.decode(chunk.value, { stream: true });
    }
    expect(html).toContain("<p>Pending</p>");
    pending.resolve("Stream completed");
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      html += decoder.decode(chunk.value, { stream: true });
    }
    html += decoder.decode();
    expect(html).toContain("Stream completed");
    expect(html).toContain("$RC(");
    expect(html).toContain("$_TSR.router=");
    expect(errors).toEqual([]);
    expect(await assertInlineScriptNonces(response, html)).toHaveLength(7);
  });
}

for (const pathname of ["/tools", "/chat/new"]) {
  test(`production ${pathname}: every inline SSR script carries the response nonce`, async () => {
    const request = new Request(`https://stella.test${pathname}`, {
      headers: {
        accept: "text/html",
        cookie: pathname === "/chat/new" ? "session=fixture" : "",
      },
    });
    const errors: unknown[] = [];
    const response = await serveDocument(
      request,
      async () =>
        await createRequestHandler({ request, createRouter: getRouter })(
          async ({ router, responseHeaders }) => {
            expect(router.state.location.pathname).toBe(pathname);
            const rendered = await renderSsrResponse({
              request,
              rendererSignal: request.signal,
              router,
              responseHeaders,
              children: <RouterServer router={router} />,
              reportError: (error) => {
                errors.push(error);
              },
            });
            if (rendered.isErr()) {
              throw rendered.error;
            }
            return rendered.value;
          },
        ),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(errors).toEqual([]);
    expect(html).toContain("/prepaint-init.js");
    expect(html).toContain("$_TSR.router=");
    await assertInlineScriptNonces(response, html);
  });
}
