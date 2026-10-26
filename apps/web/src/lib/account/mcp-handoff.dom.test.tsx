import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const { loadMcpHandoff } = await import("./mcp-handoff");

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.takeStellaHandoff = undefined;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

test.each([
  ["protected", "/matters/example?tab=notes#section=2"],
  ["public", "/law/cze/statutes/example?version=1#section=2"],
])(
  "a failed initial request follows the %s fallback and leaves retries available",
  async (kind, destination) => {
    const captured = {
      code: "sh1_sample",
      path: destination.split("#").at(0),
      destination,
    };
    let pending: typeof captured | undefined = captured;
    window.takeStellaHandoff = () => {
      const value = pending;
      pending = undefined;
      return value;
    };
    let requests = 0;
    let transport = "failed";
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (!url.includes("mcp-handoff/redeem")) {
          return Response.json(null);
        }
        requests += 1;
        if (transport === "failed") {
          throw new TypeError("Network request failed");
        }
        return Response.json({ status: "redeemed" });
      },
      { preconnect: () => undefined },
    );

    const refused = await loadMcpHandoff();
    expect(refused?.options.href).toBe(
      kind === "public"
        ? destination
        : `/auth?redirectTo=${encodeURIComponent(destination)}`,
    );
    expect(await loadMcpHandoff()).toBeUndefined();
    expect(requests).toBe(1);

    transport = "available";
    pending = captured;
    const redeemed = await loadMcpHandoff();
    expect(redeemed?.options.href).toBe(destination);
    expect(requests).toBe(2);
  },
);
