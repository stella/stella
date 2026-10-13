import { Suspense } from "react";
import type { ReactElement } from "react";

import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
import { attachRouterServerSsrUtils } from "@tanstack/react-router/ssr/server";
import { expect, test } from "bun:test";

import { renderSsrResponse } from "./ssr-renderer";

const CASE_NUMBER = "27 Cdo 59/2022";
const ROUTE_FALLBACK = "Loading route";
const DECISIONS_FALLBACK = "Loading decisions";

test("server rendering finishes when a lazy route and its pending component load together", async () => {
  const module = Promise.withResolvers<{
    Page: () => ReactElement;
    Pending: () => ReactElement;
  }>();
  const Page = lazyRouteComponent(async () => await module.promise, "Page");
  const Pending = lazyRouteComponent(
    async () => await module.promise,
    "Pending",
  );
  const errors: unknown[] = [];
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    isServer: true,
  });
  attachRouterServerSsrUtils({ router, manifest: undefined });
  await router.load();
  await router.serverSsr?.dehydrate({ signal: new AbortController().signal });
  const rendered = await renderSsrResponse({
    request: new Request("https://stella.test/"),
    rendererSignal: AbortSignal.timeout(1000),
    router,
    responseHeaders: new Headers({
      "Content-Type": "text/html; charset=utf-8",
    }),
    children: (
      <html lang="en">
        <body>
          <Suspense fallback={<main>{ROUTE_FALLBACK}</main>}>
            <Suspense fallback={<Pending />}>
              <Page />
            </Suspense>
          </Suspense>
        </body>
      </html>
    ),
    reportError: (error) => {
      errors.push(error);
    },
  });
  expect(rendered.isOk()).toBe(true);
  if (rendered.isErr()) {
    throw rendered.error;
  }
  const html = rendered.value.response.text();
  module.resolve({
    Page: () => <main>{CASE_NUMBER}</main>,
    Pending: () => <main>{DECISIONS_FALLBACK}</main>,
  });

  const document = await html;
  expect(document).toContain(CASE_NUMBER);
  expect(document).toContain("</body></html>");
  expect(errors).toEqual([]);
  expect(router.serverSsr).toBeUndefined();
});
