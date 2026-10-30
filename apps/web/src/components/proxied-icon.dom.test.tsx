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

test("icon paths on the same host use distinct proxies and blob images", async () => {
  const firstRemote = "https://connector.example/assets/first.png";
  const secondRemote = "https://connector.example/assets/second.png";
  const requests: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: URL | RequestInfo) => {
        const request = input instanceof Request ? input.url : input.toString();
        requests.push(request);
        return new Response(
          new Blob([new Uint8Array([request.includes("first.png") ? 1 : 2])], {
            type: "image/png",
          }),
        );
      },
      { preconnect: () => {} },
    ),
  );

  try {
    const view = renderWithQuery(
      <>
        <ProxiedIcon alt="first" remoteUrl={firstRemote} />
        <ProxiedIcon alt="second" remoteUrl={secondRemote} />
      </>,
    );
    await waitFor(() =>
      expect(view.container.querySelectorAll("img")).toHaveLength(2),
    );
    const sources = [...view.container.querySelectorAll("img")].map((image) =>
      image.getAttribute("src"),
    );
    expect(sources.every((src) => src?.startsWith("blob:"))).toBe(true);
    expect(new Set(sources).size).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests.some((request) => request.includes("first.png"))).toBe(
      true,
    );
    expect(requests.some((request) => request.includes("second.png"))).toBe(
      true,
    );
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
