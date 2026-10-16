import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import { createWebTestEnvironment } from "../../../../tests/environment.test-fixtures";

GlobalRegistrator.register({ url: "https://app.example.test/chat" });
const testEnvironment = createWebTestEnvironment({ file: import.meta.path });
testEnvironment.setEnvIfAbsent("VITE_API_URL", "https://api.example.test");

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { ProxyChatLink } = await import("./proxy-chat-link");
const { linkIconOptions } = await import("../link-icons");
const { apiUrl } = await import("@/lib/api-url");

class VisibleIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string;
  readonly scrollMargin: string;
  readonly thresholds: readonly number[];
  private readonly observed = new Set<Element>();
  private readonly callback: IntersectionObserverCallback;

  constructor(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.callback = callback;
    this.rootMargin = options?.rootMargin ?? "0px";
    this.scrollMargin = options?.scrollMargin ?? "0px";
    this.thresholds = Array.isArray(options?.threshold)
      ? options.threshold
      : [options?.threshold ?? 0];
    observers.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  intersectObserved(): void {
    const rect = new DOMRect(0, 0, 100, 24);
    const entries: IntersectionObserverEntry[] = [];
    for (const target of this.observed) {
      entries.push({
        boundingClientRect: rect,
        intersectionRect: rect,
        intersectionRatio: 1,
        isIntersecting: true,
        rootBounds: null,
        target,
        time: performance.now(),
      });
    }
    this.callback(entries, this);
  }
}

const LINK_LABELS = {
  source: "First link",
  reference: "Second link",
  absent: "No icon link",
  bundled: "GitHub source",
};
const observers: VisibleIntersectionObserver[] = [];
const originalIntersectionObserver = globalThis.IntersectionObserver;

afterEach(async () => {
  await act(async () => cleanup());
  observers.length = 0;
  globalThis.IntersectionObserver = originalIntersectionObserver;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

test("loads visible host icons once through the authenticated API and cleans local URLs", async () => {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = Object.getOwnPropertyDescriptor(
    URL,
    "createObjectURL",
  );
  const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(
    URL,
    "revokeObjectURL",
  );
  const requests: { url: string; credentials: RequestCredentials }[] = [];
  const created: { url: string; blob: Blob }[] = [];
  const revoked: string[] = [];
  globalThis.IntersectionObserver = VisibleIntersectionObserver;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, credentials: request.credentials });
      if (request.url.endsWith("/v1/chat/link-icons/no-icon.example")) {
        return Response.json({ type: "no-icon" });
      }
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { "content-type": "image/png" },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      const url = `blob:proxy-chat-link/${created.length}`;
      created.push({ url, blob });
      return url;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: (url: string) => revoked.push(url),
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <>
        <ProxyChatLink href="https://example.com/one">
          {LINK_LABELS.source}
        </ProxyChatLink>
        <ProxyChatLink href="https://example.com/two">
          {LINK_LABELS.reference}
        </ProxyChatLink>
        <ProxyChatLink href="https://no-icon.example/path">
          {LINK_LABELS.absent}
        </ProxyChatLink>
        <ProxyChatLink href="https://github.com/stella/stella">
          {LINK_LABELS.bundled}
        </ProxyChatLink>
      </>
    </QueryClientProvider>,
  );

  try {
    expect(requests).toHaveLength(0);
    expect(observers).toHaveLength(4);
    await act(async () => {
      for (const observer of [...observers]) {
        observer.intersectObserved();
      }
    });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests).toEqual([
      {
        url: apiUrl("/chat/link-icons/example.com"),
        credentials: "include",
      },
      {
        url: apiUrl("/chat/link-icons/no-icon.example"),
        credentials: "include",
      },
    ]);
    expect(requests.every(({ url }) => !url.includes("favicon"))).toBe(true);

    await waitFor(() => expect(created).toHaveLength(2));
    const firstCreated = created.at(0);
    const secondCreated = created.at(1);
    if (!firstCreated || !secondCreated) {
      throw new TypeError("Expected both link object URLs");
    }
    expect(firstCreated.url).not.toBe(secondCreated.url);
    expect(firstCreated.blob).toBe(secondCreated.blob);
    for (const { blob } of created) {
      expect(blob.type).toBe("image/png");
      expect(blob.size).toBe(4);
      expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([
        0x89, 0x50, 0x4e, 0x47,
      ]);
    }
    const links = view.getAllByRole("link");
    expect(links).toHaveLength(4);
    expect(links[0]?.getAttribute("href")).toBe("https://example.com/one");
    expect(links[1]?.getAttribute("href")).toBe("https://example.com/two");
    expect(links[0]?.querySelector("img")?.getAttribute("src")).toBe(
      firstCreated.url,
    );
    expect(links[1]?.querySelector("img")?.getAttribute("src")).toBe(
      secondCreated.url,
    );
    expect(links[2]?.querySelector("img")).toBeNull();
    expect(
      links[2]?.querySelector("svg")?.classList.contains("lucide-globe"),
    ).toBe(true);
    expect(links[3]?.getAttribute("href")).toBe(
      "https://github.com/stella/stella",
    );
    expect(links[3]?.querySelector("svg")).not.toBeNull();

    const firstIcon = links[0]?.querySelector("img");
    if (!firstIcon) {
      throw new TypeError("Expected the proxied icon");
    }
    fireEvent.error(firstIcon);
    expect(links[0]?.querySelector("img")).toBeNull();
    expect(
      links[0]?.querySelector("svg")?.classList.contains("lucide-globe"),
    ).toBe(true);
    expect(links[0]?.getAttribute("href")).toBe("https://example.com/one");

    view.unmount();
    expect(revoked).toEqual(created.map(({ url }) => url));
  } finally {
    view.unmount();
    queryClient.clear();
    globalThis.fetch = originalFetch;
    if (originalCreateObjectURL) {
      Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
    } else {
      Reflect.deleteProperty(URL, "createObjectURL");
    }
    if (originalRevokeObjectURL) {
      Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
    } else {
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  }
});

for (const { disposition, requestsExpected } of [
  { disposition: "temporary", requestsExpected: 2 },
  { disposition: "no-icon", requestsExpected: 1 },
  { disposition: "icon", requestsExpected: 1 },
]) {
  test(`only temporary icon outcomes become stale immediately: ${disposition}`, async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        return disposition === "icon"
          ? new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
              headers: { "content-type": "image/png" },
            })
          : Response.json({ type: disposition });
      },
      { preconnect: originalFetch.preconnect },
    );
    const client = new QueryClient();
    try {
      const options = linkIconOptions("retry.example");
      const first = await client.fetchQuery(options);
      expect(first.type).toBe(disposition);
      await client.fetchQuery(options);
      expect(requests).toBe(requestsExpected);
    } finally {
      client.clear();
      globalThis.fetch = originalFetch;
    }
  });
}
