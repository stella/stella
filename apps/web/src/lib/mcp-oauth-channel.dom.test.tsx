import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, spyOn, test } from "bun:test";

import { requireBrowserStorage } from "@/lib/account/browser-storage";
import { MCP_OAUTH_REQUEST_STORAGE_KEY } from "@/lib/account/storage-keys";
import { createRandomValue } from "@/lib/uuid";
import { unregisterDomEnvironment } from "@/test-dom-environment";

const NativeMessageEvent = globalThis.MessageEvent;
GlobalRegistrator.register({ url: "http://localhost:3000/knowledge/tools" });
const { render, fireEvent } = await import("@testing-library/react");
const { openMcpOAuthWindow, subscribeToMcpOAuthOutcome } =
  await import("./mcp-oauth-channel");

const emit = (nonce: string | null | undefined) => {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin: window.location.origin,
      data: {
        kind: "stll.mcp-oauth",
        status: "connected",
        ...(nonce ? { nonce } : {}),
      },
    }),
  );
};

afterAll(async () => {
  await unregisterDomEnvironment();
});

test("concurrent authorization windows deliver only their own completion", () => {
  const open = spyOn(window, "open").mockReturnValue(window);
  const first: unknown[] = [];
  const second: unknown[] = [];
  try {
    openMcpOAuthWindow("https://example.test/authorize", (outcome) => {
      first.push(outcome);
    });
    const firstNonce = requireBrowserStorage("session")
      .unwrap()
      .getItem(MCP_OAUTH_REQUEST_STORAGE_KEY);
    openMcpOAuthWindow("https://example.test/authorize", (outcome) => {
      second.push(outcome);
    });
    const secondNonce = requireBrowserStorage("session")
      .unwrap()
      .getItem(MCP_OAUTH_REQUEST_STORAGE_KEY);
    emit(secondNonce);
    expect(first).toEqual([]);
    expect(second).toEqual([{ status: "connected" }]);
    emit(firstNonce);
    expect(first).toEqual([{ status: "connected" }]);
    expect(second).toEqual([{ status: "connected" }]);
    expect(firstNonce).not.toBe(secondNonce);
  } finally {
    open.mockRestore();
  }
});

test("a pending window refuses missing, foreign and other-origin completion", () => {
  const open = spyOn(window, "open").mockReturnValue(window);
  const observed: unknown[] = [];
  const unsubscribe = subscribeToMcpOAuthOutcome((outcome) => {
    observed.push(outcome);
  });
  try {
    openMcpOAuthWindow("https://example.test/authorize");
    const nonce = requireBrowserStorage("session")
      .unwrap()
      .getItem(MCP_OAUTH_REQUEST_STORAGE_KEY);
    emit(undefined);
    emit(createRandomValue());
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://example.test",
        data: { kind: "stll.mcp-oauth", status: "connected", nonce },
      }),
    );
    expect(observed).toEqual([]);
    emit(nonce);
    expect(observed).toEqual([{ status: "connected" }]);
  } finally {
    unsubscribe();
    open.mockRestore();
  }
});

test("completed authorization windows notify observers once", () => {
  const open = spyOn(window, "open").mockReturnValue(window);
  const observed: unknown[] = [];
  const unsubscribe = subscribeToMcpOAuthOutcome((outcome) => {
    observed.push(outcome);
  });
  try {
    openMcpOAuthWindow("https://example.test/authorize");
    const nonce = requireBrowserStorage("session")
      .unwrap()
      .getItem(MCP_OAUTH_REQUEST_STORAGE_KEY);
    emit(nonce);
    emit(nonce);
    expect(observed).toEqual([{ status: "connected" }]);
  } finally {
    unsubscribe();
    open.mockRestore();
  }
});

test("authorization receipts distinguish invalid, foreign, expired and completed messages", async () => {
  const { createMcpOAuthRequest } = await import("./mcp-oauth-channel");
  let now = 0;
  const request = createMcpOAuthRequest(() => now);
  const completion = {
    kind: "stll.mcp-oauth",
    nonce: request.nonce,
    status: "connected",
  };
  expect(
    request.receive({ kind: "stll.mcp-oauth", status: "connected" }),
  ).toEqual({ type: "refused", reason: "invalid" });
  expect(
    request.receive({ ...completion, nonce: createRandomValue() }),
  ).toEqual({ type: "refused", reason: "foreign" });
  expect(request.receive(completion)).toEqual({
    type: "accepted",
    outcome: { status: "connected" },
  });
  expect(request.receive(completion)).toEqual({
    type: "refused",
    reason: "completed",
  });
  const expired = createMcpOAuthRequest(() => now);
  now = 10 * 60 * 1000;
  expect(expired.receive({ ...completion, nonce: expired.nonce })).toEqual({
    type: "refused",
    reason: "expired",
  });
});

test("callback consumes its origin-scoped request nonce once", async () => {
  const { broadcastMcpOAuthOutcome } = await import("./mcp-oauth-channel");
  const open = spyOn(window, "open").mockReturnValue(window);
  const observed: unknown[] = [];
  const unsubscribe = subscribeToMcpOAuthOutcome((outcome) => {
    observed.push(outcome);
  });
  try {
    openMcpOAuthWindow("https://example.test/authorize");
    expect(
      requireBrowserStorage("session")
        .unwrap()
        .getItem(MCP_OAUTH_REQUEST_STORAGE_KEY),
    ).not.toBeNull();
    broadcastMcpOAuthOutcome({ status: "error", reason: "cancelled" });
    expect(
      requireBrowserStorage("session")
        .unwrap()
        .getItem(MCP_OAUTH_REQUEST_STORAGE_KEY),
    ).toBeNull();
    broadcastMcpOAuthOutcome({ status: "connected" });
    await new Promise<void>((resolve) => {
      const unsubscribeCompletion = subscribeToMcpOAuthOutcome(() => {
        unsubscribeCompletion();
        resolve();
      });
    });
    expect(observed).toEqual([{ status: "error", reason: "cancelled" }]);
  } finally {
    unsubscribe();
    open.mockRestore();
  }
});

test("blocked popup completion refreshes once and consumes its redirect request", async () => {
  const { broadcastMcpOAuthOutcome, subscribeToMcpConnectionRefresh } =
    await import("./mcp-oauth-channel");
  const OriginalBroadcastChannel = globalThis.BroadcastChannel;
  const peers = new Set<BroadcastChannel>();
  class RefreshOnlyBroadcastChannel extends OriginalBroadcastChannel {
    constructor(name: string) {
      super(name);
      peers.add(this);
    }
    override postMessage(message: unknown): void {
      if (this.name !== "mcp-oauth-refresh") {
        return;
      }
      for (const peer of peers) {
        if (peer !== this && peer.name === this.name) {
          peer.dispatchEvent(
            new NativeMessageEvent("message", { data: message }),
          );
        }
      }
    }
    override close(): void {
      peers.delete(this);
      super.close();
    }
  }
  globalThis.BroadcastChannel = RefreshOnlyBroadcastChannel;
  const open = spyOn(window, "open").mockReturnValue(null);
  const assign = spyOn(window.location, "assign").mockImplementation(() => {});
  let refreshes = 0;
  const unsubscribe = subscribeToMcpConnectionRefresh(() => {
    refreshes += 1;
  });
  try {
    expect(openMcpOAuthWindow("https://example.test/authorize")).toBe(
      "redirected",
    );
    const storage = requireBrowserStorage("session").unwrap();
    const nonce = storage.getItem(MCP_OAUTH_REQUEST_STORAGE_KEY);
    expect(nonce).not.toBeNull();
    if (nonce === null) {
      throw new Error("Redirect request nonce was not stored");
    }
    const redirectKey = `${MCP_OAUTH_REQUEST_STORAGE_KEY}:${nonce}`;
    expect(storage.getItem(redirectKey)).not.toBeNull();

    broadcastMcpOAuthOutcome({ status: "connected" });

    expect(refreshes).toBe(1);
    expect(storage.getItem(redirectKey)).toBeNull();
  } finally {
    unsubscribe();
    for (const peer of peers) {
      peer.close();
    }
    assign.mockRestore();
    open.mockRestore();
    globalThis.BroadcastChannel = OriginalBroadcastChannel;
  }
});

test("callback with a forged redirect nonce does not refresh connections", async () => {
  const { broadcastMcpOAuthOutcome, subscribeToMcpConnectionRefresh } =
    await import("./mcp-oauth-channel");
  const storage = requireBrowserStorage("session").unwrap();
  storage.setItem(MCP_OAUTH_REQUEST_STORAGE_KEY, createRandomValue());
  let refreshes = 0;
  const unsubscribe = subscribeToMcpConnectionRefresh(() => {
    refreshes += 1;
  });
  try {
    broadcastMcpOAuthOutcome({ status: "connected" });
    expect(refreshes).toBe(0);
  } finally {
    unsubscribe();
  }
});

const REDIRECT_PREFIX = `${MCP_OAUTH_REQUEST_STORAGE_KEY}:`;

const countRefreshes = async (run: () => void) => {
  const { subscribeToMcpConnectionRefresh } =
    await import("./mcp-oauth-channel");
  const OriginalBroadcastChannel = globalThis.BroadcastChannel;
  const peers = new Set<BroadcastChannel>();
  class RefreshOnlyBroadcastChannel extends OriginalBroadcastChannel {
    constructor(name: string) {
      super(name);
      peers.add(this);
    }
    override postMessage(message: unknown): void {
      if (this.name !== "mcp-oauth-refresh") {
        return;
      }
      for (const peer of peers) {
        if (peer !== this && peer.name === this.name) {
          peer.dispatchEvent(
            new NativeMessageEvent("message", { data: message }),
          );
        }
      }
    }
    override close(): void {
      peers.delete(this);
      super.close();
    }
  }
  globalThis.BroadcastChannel = RefreshOnlyBroadcastChannel;
  let refreshes = 0;
  const unsubscribe = subscribeToMcpConnectionRefresh(() => {
    refreshes += 1;
  });
  try {
    run();
    return refreshes;
  } finally {
    unsubscribe();
    for (const peer of peers) {
      peer.close();
    }
    globalThis.BroadcastChannel = OriginalBroadcastChannel;
  }
};

const callbackWithRecord = async (record: string) => {
  const { broadcastMcpOAuthOutcome } = await import("./mcp-oauth-channel");
  const storage = requireBrowserStorage("session").unwrap();
  const nonce = createRandomValue();
  const key = `${REDIRECT_PREFIX}${nonce}`;
  storage.setItem(key, record);
  const refreshes = await countRefreshes(() => {
    storage.setItem(MCP_OAUTH_REQUEST_STORAGE_KEY, nonce);
    broadcastMcpOAuthOutcome({ status: "connected" });
  });
  return { key, refreshes, storage };
};

test("a second callback with a consumed redirect record does not refresh", async () => {
  const { broadcastMcpOAuthOutcome } = await import("./mcp-oauth-channel");
  const valid = JSON.stringify({ expiresAt: Date.now() + 60_000 });
  const first = await callbackWithRecord(valid);
  expect(first.refreshes).toBe(1);
  expect(first.storage.getItem(first.key)).toBeNull();
  const nonce = first.key.slice(REDIRECT_PREFIX.length);
  const refreshes = await countRefreshes(() => {
    first.storage.setItem(MCP_OAUTH_REQUEST_STORAGE_KEY, nonce);
    broadcastMcpOAuthOutcome({ status: "connected" });
  });
  expect(refreshes).toBe(0);
});

test("an expired redirect record is refused and removed", async () => {
  const { key, refreshes, storage } = await callbackWithRecord(
    JSON.stringify({ expiresAt: Date.now() - 1 }),
  );
  expect(refreshes).toBe(0);
  expect(storage.getItem(key)).toBeNull();
});

test("a schema-invalid redirect record is refused and removed", async () => {
  for (const record of ["{}", "{not json", '{"expiresAt":"soon"}']) {
    const { key, refreshes, storage } = await callbackWithRecord(record);
    expect(refreshes).toBe(0);
    expect(storage.getItem(key)).toBeNull();
  }
});

test("the sweep removes expired and invalid unread redirect records", async () => {
  const storage = requireBrowserStorage("session").unwrap();
  const expiredKey = `${REDIRECT_PREFIX}expired`;
  const invalidKey = `${REDIRECT_PREFIX}invalid`;
  const malformedKey = `${REDIRECT_PREFIX}malformed`;
  const validKey = `${REDIRECT_PREFIX}valid`;
  // Another registered session family the sweep must leave alone.
  const unrelatedKey = "contact-import-request:v1:unrelated";
  storage.setItem(expiredKey, JSON.stringify({ expiresAt: Date.now() - 1 }));
  storage.setItem(invalidKey, "{}");
  storage.setItem(malformedKey, "{not json");
  storage.setItem(validKey, JSON.stringify({ expiresAt: Date.now() + 60_000 }));
  storage.setItem(unrelatedKey, "{}");
  try {
    const { sweepStaleRedirectRequests } = await import("./mcp-oauth-channel");
    sweepStaleRedirectRequests();
    expect(storage.getItem(expiredKey)).toBeNull();
    expect(storage.getItem(invalidKey)).toBeNull();
    expect(storage.getItem(malformedKey)).toBeNull();
    expect(storage.getItem(validKey)).not.toBeNull();
    expect(storage.getItem(unrelatedKey)).toBe("{}");
  } finally {
    storage.removeItem(validKey);
    storage.removeItem(unrelatedKey);
  }
});

test("authorization URL validation runs before opening a window", () => {
  const open = spyOn(window, "open").mockReturnValue(window);
  try {
    for (const url of [
      "data:text/plain,example",
      "ftp://example.test",
      "not a URL",
    ]) {
      expect(openMcpOAuthWindow(url)).toBe("invalid");
    }
    expect(open).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
  }
});

test("unmounted request callbacks expire while mounted connection observers refresh", async () => {
  const { createElement } = await import("react");
  const { useMcpOAuthWindow } = await import("./mcp-oauth-channel");
  const open = spyOn(window, "open").mockReturnValue(window);
  const callbacks: unknown[] = [];
  const observed: unknown[] = [];
  const unsubscribe = subscribeToMcpOAuthOutcome((outcome) => {
    observed.push(outcome);
  });
  const RequestControl = () => {
    const openWindow = useMcpOAuthWindow((outcome) => {
      callbacks.push(outcome);
    });
    return createElement(
      "button",
      {
        type: "button",
        onClick: () => openWindow("https://example.test/authorize"),
      },
      "Connect",
    );
  };
  const view = render(createElement(RequestControl));
  try {
    fireEvent.click(view.getByRole("button"));
    const nonce = requireBrowserStorage("session")
      .unwrap()
      .getItem(MCP_OAUTH_REQUEST_STORAGE_KEY);
    view.unmount();
    emit(nonce);
    expect(callbacks).toEqual([]);
    expect(observed).toEqual([{ status: "connected" }]);
  } finally {
    view.unmount();
    unsubscribe();
    open.mockRestore();
  }
});

test("connection refresh signals leave pending authorization outcomes untouched", async () => {
  const { subscribeToMcpConnectionRefresh } =
    await import("./mcp-oauth-channel");
  const OriginalBroadcastChannel = globalThis.BroadcastChannel;
  const peers = new Set<BroadcastChannel>();
  class SynchronousBroadcastChannel extends OriginalBroadcastChannel {
    constructor(name: string) {
      super(name);
      peers.add(this);
    }
    override postMessage(message: unknown): void {
      for (const peer of peers) {
        if (peer !== this && peer.name === this.name) {
          peer.dispatchEvent(
            new NativeMessageEvent("message", { data: message }),
          );
        }
      }
    }
    override close(): void {
      peers.delete(this);
      super.close();
    }
  }
  globalThis.BroadcastChannel = SynchronousBroadcastChannel;
  const open = spyOn(window, "open").mockReturnValue(window);
  let refreshes = 0;
  let completions = 0;
  const unsubscribe = subscribeToMcpConnectionRefresh(() => {
    refreshes += 1;
  });
  const remote = new BroadcastChannel("mcp-oauth-refresh");
  try {
    openMcpOAuthWindow("https://example.test/authorize", () => {
      completions += 1;
    });
    const nonce = requireBrowserStorage("session")
      .unwrap()
      .getItem(MCP_OAUTH_REQUEST_STORAGE_KEY);
    const post = remote.postMessage.bind(remote);
    post({ kind: "stll.mcp-oauth-refresh", status: "connected" });
    expect(refreshes).toBe(0);
    expect(completions).toBe(0);
    post({ kind: "stll.mcp-oauth-refresh" });
    expect(refreshes).toBe(1);
    expect(completions).toBe(0);
    emit(nonce);
    expect(refreshes).toBe(2);
    expect(completions).toBe(1);
  } finally {
    unsubscribe();
    for (const peer of peers) {
      peer.close();
    }
    open.mockRestore();
    globalThis.BroadcastChannel = OriginalBroadcastChannel;
  }
});

test("accepted completions refresh this tab when broadcast channels are unavailable", async () => {
  const { subscribeToMcpConnectionRefresh } =
    await import("./mcp-oauth-channel");
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "BroadcastChannel",
  );
  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  const open = spyOn(window, "open").mockReturnValue(window);
  let refreshes = 0;
  const unsubscribe = subscribeToMcpConnectionRefresh(() => {
    refreshes += 1;
  });
  try {
    openMcpOAuthWindow("https://example.test/authorize");
    const nonce = requireBrowserStorage("session")
      .unwrap()
      .getItem(MCP_OAUTH_REQUEST_STORAGE_KEY);
    emit(nonce);
    emit(nonce);
    expect(refreshes).toBe(1);
  } finally {
    unsubscribe();
    open.mockRestore();
    if (descriptor) {
      Object.defineProperty(globalThis, "BroadcastChannel", descriptor);
    } else {
      Reflect.deleteProperty(globalThis, "BroadcastChannel");
    }
  }
});
