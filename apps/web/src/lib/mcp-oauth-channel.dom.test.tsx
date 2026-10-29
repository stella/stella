import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, spyOn, test } from "bun:test";

import { requireBrowserStorage } from "@/lib/account/browser-storage";
import { MCP_OAUTH_REQUEST_STORAGE_KEY } from "@/lib/account/storage-keys";
import { createRandomValue } from "@/lib/uuid";
import { unregisterDomEnvironment } from "@/test-dom-environment";

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
    openMcpOAuthWindow("https://example.test/authorize", (outcome) =>
      first.push(outcome),
    );
    const firstNonce = requireBrowserStorage("session")
      .unwrap()
      .getItem(MCP_OAUTH_REQUEST_STORAGE_KEY);
    openMcpOAuthWindow("https://example.test/authorize", (outcome) =>
      second.push(outcome),
    );
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
  const unsubscribe = subscribeToMcpOAuthOutcome((outcome) =>
    observed.push(outcome),
  );
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
  const unsubscribe = subscribeToMcpOAuthOutcome((outcome) =>
    observed.push(outcome),
  );
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
  const unsubscribe = subscribeToMcpOAuthOutcome((outcome) =>
    observed.push(outcome),
  );
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
  const unsubscribe = subscribeToMcpOAuthOutcome((outcome) =>
    observed.push(outcome),
  );
  const RequestControl = () => {
    const openWindow = useMcpOAuthWindow((outcome) => callbacks.push(outcome));
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
