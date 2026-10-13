import { Suspense } from "react";
import type { ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";

import { lazyRouteComponent } from "@tanstack/react-router";
import { expect, test } from "bun:test";

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
  const stream = await renderToReadableStream(
    <html lang="en">
      <body>
        <Suspense fallback={<main>{ROUTE_FALLBACK}</main>}>
          <Suspense fallback={<Pending />}>
            <Page />
          </Suspense>
        </Suspense>
      </body>
    </html>,
    {
      onError: (error) => {
        errors.push(error);
      },
      signal: AbortSignal.timeout(1000),
    },
  );
  const html = new Response(stream).text();
  module.resolve({
    Page: () => <main>{CASE_NUMBER}</main>,
    Pending: () => <main>{DECISIONS_FALLBACK}</main>,
  });

  const document = await html;
  expect(document).toContain(CASE_NUMBER);
  expect(document).toEndWith("</body></html>");
  expect(errors).toEqual([]);
});
