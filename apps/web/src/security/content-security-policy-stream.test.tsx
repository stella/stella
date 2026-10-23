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
import { expect, test } from "bun:test";

import { renderSsrResponse } from "../ssr-renderer";
import { withContentSecurityPolicy } from "./content-security-policy.server";
import { getRequestSsrOptions } from "./ssr-options";

const PENDING_TEXT = "Pending";
const SCRIPT_ONCE_SOURCE = "window.onceScript = true";

const environment = {
  apiBase: "https://stella.test/api",
  desktopBridgePort: 45_901,
  documentsBucket: "documents",
  documentsEndpoint: "https://objects.stella.test",
  sandboxUrl: "https://stella.test/sandbox",
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
    const response = await withContentSecurityPolicy({
      environment,
      fetchResponse: async () =>
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
    });
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
    const nonce = /'nonce-([^']+)'/u
      .exec(response.headers.get("Content-Security-Policy") ?? "")
      ?.at(1);
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
    expect(inlineNonces.length).toBeGreaterThan(2);
    expect(
      inlineNonces,
      "all inline SSR script nonces match the CSP header",
    ).toEqual(inlineNonces.map(() => nonce));
  });
}
