import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { cleanup, render, waitFor } = await import("@testing-library/react");
const { CatalogueEntryIcon } =
  await import("@/components/catalogue/catalogue-entry-icon");
const { ProxiedIcon } = await import("@/components/proxied-icon");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

const renderWithQuery = (node: ReactNode) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {node}
    </QueryClientProvider>,
  );

test("connector icons render only API-fetched blob URLs", async () => {
  const remote = "https://connector.example/assets/icon.png";
  const requests: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: URL | RequestInfo) => {
        requests.push(input instanceof Request ? input.url : input.toString());
        return new Response(
          new Blob([new Uint8Array([1])], { type: "image/png" }),
        );
      },
      { preconnect: () => {} },
    ),
  );

  try {
    const view = renderWithQuery(<ProxiedIcon alt="" remoteUrl={remote} />);
    await waitFor(() =>
      expect(view.container.querySelector("img")).not.toBeNull(),
    );
    const src = view.container.querySelector("img")?.getAttribute("src");
    expect(src?.startsWith("blob:")).toBe(true);
    expect(src).not.toContain("connector.example");
    expect(
      requests.some((request) =>
        request.includes("link-icons/connector.example"),
      ),
    ).toBe(true);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("catalogue remote fallbacks render only API-fetched blob URLs", async () => {
  const remote = "https://catalogue.example/icon.png";
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () =>
        new Response(new Blob([new Uint8Array([1])], { type: "image/png" })),
      { preconnect: () => {} },
    ),
  );

  try {
    const view = renderWithQuery(<CatalogueEntryIcon iconUrl={remote} />);
    await waitFor(() =>
      expect(view.container.querySelector("img")).not.toBeNull(),
    );
    const src = view.container.querySelector("img")?.getAttribute("src");
    expect(src?.startsWith("blob:")).toBe(true);
    expect(src).not.toContain("catalogue.example");
  } finally {
    fetchSpy.mockRestore();
  }
});
