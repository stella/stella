import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, jest, test } from "bun:test";

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

  intersectObserved(isIntersecting = true): void {
    const rect = new DOMRect(0, 0, 100, 24);
    const entries: IntersectionObserverEntry[] = [];
    for (const target of this.observed) {
      entries.push({
        boundingClientRect: rect,
        intersectionRect: rect,
        intersectionRatio: isIntersecting ? 1 : 0,
        isIntersecting,
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

test.each([
  {
    kind: "model-text" as const,
    site: "cached.example",
    sourceHref: "https://a.cached.example/source",
    blockedHref: "https://b.cached.example/prose",
  },
  {
    kind: "tool-source" as const,
    site: "github.com",
    sourceHref: "https://a.github.com/source",
    blockedHref: "https://github.com/stella/stella",
  },
])(
  "a $kind link keeps its own icon policy when its site icon is cached",
  async ({ kind, site, sourceHref, blockedHref }) => {
    const originalFetch = globalThis.fetch;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const requests: string[] = [];
    globalThis.IntersectionObserver = VisibleIntersectionObserver;
    URL.createObjectURL = () => "blob:cached-site-icon";
    URL.revokeObjectURL = () => undefined;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        requests.push(new Request(input).url);
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          headers: { "content-type": "image/png" },
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <ProxyChatLink href={sourceHref} iconSource={{ kind: "tool-source" }}>
          {LINK_LABELS.source}
        </ProxyChatLink>
        <ProxyChatLink href={blockedHref} iconSource={{ kind }}>
          {LINK_LABELS.absent}
        </ProxyChatLink>
      </QueryClientProvider>,
    );
    const iconIn = (label: string) =>
      view.getByText(label).closest("a")?.querySelector("img") ?? null;
    try {
      await act(async () => {
        for (const observer of [...observers]) {
          observer.intersectObserved();
        }
      });
      // The eligible source fetched the shared site icon; the other link keeps
      // its model-text or bundled-icon policy despite sharing the cache entry.
      await waitFor(() => expect(iconIn(LINK_LABELS.source)).not.toBeNull());
      expect(iconIn(LINK_LABELS.absent)).toBeNull();
      expect(requests).toEqual([apiUrl(`/chat/link-icons/${site}`)]);
      if (kind === "tool-source") {
        const link = view.getByText(LINK_LABELS.absent).closest("a");
        expect(link?.querySelector("svg")).not.toBeNull();
        expect(link?.querySelector(".lucide-globe")).toBeNull();
      }
    } finally {
      view.unmount();
      client.clear();
      globalThis.fetch = originalFetch;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  },
);

test("requests one site icon only for visible tool-source links", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.IntersectionObserver = VisibleIntersectionObserver;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(new Request(input).url);
      return Response.json({ type: "no-icon" });
    },
    { preconnect: originalFetch.preconnect },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ProxyChatLink
        href="https://model.example/path"
        iconSource={{ kind: "model-text" }}
      >
        {LINK_LABELS.absent}
      </ProxyChatLink>
      <ProxyChatLink
        href="https://a.attacker.example/one"
        iconSource={{ kind: "tool-source" }}
      >
        {LINK_LABELS.source}
      </ProxyChatLink>
      <ProxyChatLink
        href="https://b.attacker.example/two"
        iconSource={{ kind: "tool-source" }}
      >
        {LINK_LABELS.reference}
      </ProxyChatLink>
    </QueryClientProvider>,
  );
  try {
    await act(async () => {
      for (const observer of [...observers]) {
        observer.intersectObserved();
      }
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests).toEqual([apiUrl("/chat/link-icons/attacker.example")]);
  } finally {
    view.unmount();
    client.clear();
    globalThis.fetch = originalFetch;
  }
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
        <ProxyChatLink
          iconSource={{ kind: "tool-source" }}
          href="https://example.com/one"
        >
          {LINK_LABELS.source}
        </ProxyChatLink>
        <ProxyChatLink
          iconSource={{ kind: "tool-source" }}
          href="https://example.com/two"
        >
          {LINK_LABELS.reference}
        </ProxyChatLink>
        <ProxyChatLink
          iconSource={{ kind: "tool-source" }}
          href="https://no-icon.example/path"
        >
          {LINK_LABELS.absent}
        </ProxyChatLink>
        <ProxyChatLink
          iconSource={{ kind: "tool-source" }}
          href="https://github.com/stella/stella"
        >
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

const advanceIconTimers = async (milliseconds: number) => {
  await act(async () => {
    jest.advanceTimersByTime(milliseconds);
  });
  for (let turn = 0; turn < 10; turn += 1) {
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
  }
};

for (const { disposition } of [
  { disposition: "temporary" },
  { disposition: "no-icon" },
  { disposition: "icon" },
  { disposition: "recover" },
] as const) {
  test(`visible icon polling backs off and terminates: ${disposition}`, async () => {
    jest.useFakeTimers();
    const originalFetch = globalThis.fetch;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const requests: number[] = [];
    let elapsed = 0;
    globalThis.IntersectionObserver = VisibleIntersectionObserver;
    URL.createObjectURL = () => "blob:recovered-icon";
    URL.revokeObjectURL = () => undefined;
    globalThis.fetch = Object.assign(
      async () => {
        requests.push(elapsed);
        return disposition === "icon" ||
          (disposition === "recover" && elapsed >= 10_000)
          ? new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
              headers: { "content-type": "image/png" },
            })
          : Response.json({
              type: disposition === "no-icon" ? "no-icon" : "temporary",
            });
      },
      { preconnect: originalFetch.preconnect },
    );
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <ProxyChatLink
          iconSource={{ kind: "tool-source" }}
          href="https://retry.example/source"
        >
          {LINK_LABELS.source}
        </ProxyChatLink>
      </QueryClientProvider>,
    );
    try {
      await act(async () => {
        for (const observer of [...observers]) {
          observer.intersectObserved();
        }
      });
      await advanceIconTimers(0);
      expect(requests).toEqual([0]);
      for (const delay of [2000, 4000, 8000]) {
        const before = requests.length;
        elapsed += delay;
        await advanceIconTimers(delay);
        expect(requests.length).toBe(
          disposition === "no-icon" || disposition === "icon" ? 1 : before + 1,
        );
      }
      expect(requests).toEqual(
        disposition === "no-icon" || disposition === "icon"
          ? [0]
          : [0, 2000, 6000, 14_000],
      );
      await advanceIconTimers(60_000);
      expect(requests).toHaveLength(
        disposition === "no-icon" || disposition === "icon" ? 1 : 4,
      );
      expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
        disposition === "icon" || disposition === "recover"
          ? "blob:recovered-icon"
          : undefined,
      );
    } finally {
      view.unmount();
      client.clear();
      globalThis.fetch = originalFetch;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });
}

for (const { stop } of [{ stop: "hidden" }, { stop: "unmounted" }] as const) {
  test(`temporary icon polling stops when ${stop}`, async () => {
    jest.useFakeTimers();
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.IntersectionObserver = VisibleIntersectionObserver;
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        return Response.json({ type: "temporary" });
      },
      { preconnect: originalFetch.preconnect },
    );
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <ProxyChatLink
          iconSource={{ kind: "tool-source" }}
          href="https://retry.example/source"
        >
          {LINK_LABELS.source}
        </ProxyChatLink>
      </QueryClientProvider>,
    );
    try {
      await act(async () => {
        for (const observer of [...observers]) {
          observer.intersectObserved();
        }
      });
      await advanceIconTimers(0);
      expect(requests).toBe(1);
      await act(async () => {
        if (stop === "unmounted") {
          view.unmount();
          return;
        }
        for (const observer of [...observers]) {
          observer.intersectObserved(false);
        }
      });
      await advanceIconTimers(60_000);
      expect(requests).toBe(1);
    } finally {
      view.unmount();
      client.clear();
      globalThis.fetch = originalFetch;
    }
  });
}

test("earlier terminal cache updates do not consume a mounted link's temporary retry budget", async () => {
  jest.useFakeTimers();
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let elapsed = 0;
  const requests: number[] = [];
  globalThis.IntersectionObserver = VisibleIntersectionObserver;
  URL.createObjectURL = () => "blob:recovered-icon";
  URL.revokeObjectURL = () => undefined;
  globalThis.fetch = Object.assign(
    async () => {
      requests.push(elapsed);
      return elapsed >= 10_000
        ? new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
            headers: { "content-type": "image/png" },
          })
        : Response.json({ type: "temporary" });
    },
    { preconnect: originalFetch.preconnect },
  );
  const client = new QueryClient();
  const options = linkIconOptions("retry.example");
  for (let update = 0; update < 6; update += 1) {
    client.setQueryData(
      options.queryKey,
      { type: "no-icon" },
      { updatedAt: 0 },
    );
  }
  expect(client.getQueryState(options.queryKey)?.dataUpdateCount).toBe(6);
  const view = render(
    <QueryClientProvider client={client}>
      <ProxyChatLink
        iconSource={{ kind: "tool-source" }}
        href="https://retry.example/source"
      >
        {LINK_LABELS.source}
      </ProxyChatLink>
    </QueryClientProvider>,
  );
  try {
    await act(async () => {
      for (const observer of [...observers]) {
        observer.intersectObserved();
      }
    });
    await advanceIconTimers(0);
    for (const delay of [2000, 4000, 8000]) {
      elapsed += delay;
      await advanceIconTimers(delay);
    }
    expect(requests).toEqual([0, 2000, 6000, 14_000]);
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:recovered-icon",
    );
    await advanceIconTimers(60_000);
    expect(requests).toHaveLength(4);
  } finally {
    view.unmount();
    client.clear();
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});
