import { QueryClient } from "@tanstack/react-query";
import { afterAll, describe, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

// The session the server reports; changed by "another tab".
let signedIn: string | null = "user-a";
let sessionReads = 0;

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    await Promise.resolve();
    if (url.pathname.endsWith("/api/auth/get-session")) {
      sessionReads += 1;
      const member = signedIn;
      return Response.json(
        member === null
          ? null
          : {
              session: { userId: member, activeOrganizationId: "org-x" },
              user: { id: member, email: "member@example.test", name: "" },
            },
      );
    }
    return Response.json(null, { status: 404 });
  },
  { preconnect: () => undefined },
);

const { sessionOptions } = await import("@/lib/auth-queries");
const { installSessionChangeListener } =
  await import("@/lib/account/session-change-listener");
const { installSessionCacheGuard } = await import("@/lib/session-cache-guard");
const { installUserScopedStorage } =
  await import("@/lib/account/install-user-scoped-storage");

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** A second tab: its cache, its view state and the reloads it asks for. */
const createTab = async () => {
  const queryClient = new QueryClient();
  await queryClient.query(sessionOptions);
  let hidden = false;
  let signal: () => void = () => undefined;
  let restored: () => void = () => undefined;
  let visible: () => void = () => undefined;
  const reloads: number[] = [];
  installSessionChangeListener(queryClient, {
    listen: (onSignal) => {
      signal = onSignal;
      return () => undefined;
    },
    onRestore: (listener) => {
      restored = listener;
      return () => undefined;
    },
    isHidden: () => hidden,
    onVisible: (listener) => {
      visible = listener;
      return () => undefined;
    },
    reloadDocument: () => {
      reloads.push(reloads.length);
    },
  });
  return {
    queryClient,
    reloads,
    receive: () => {
      signal();
    },
    restore: () => {
      restored();
    },
    hide: () => {
      hidden = true;
    },
    show: () => {
      hidden = false;
      visible();
    },
  };
};

const settle = async () => {
  await sleep(20);
};

describe("a tab told that the session changed elsewhere", () => {
  test("resets once when its user signed out, however many notes arrive", async () => {
    signedIn = "user-a";
    const tab = await createTab();

    signedIn = null;
    tab.receive();
    tab.receive();
    await settle();

    expect(tab.reloads).toHaveLength(1);
  });

  test("reads its session again past the usual freshness window", async () => {
    signedIn = "user-a";
    const tab = await createTab();
    const readsBefore = sessionReads;

    tab.receive();
    await settle();

    expect(sessionReads).toBe(readsBefore + 1);
  });

  test("the same user still signed in changes nothing", async () => {
    signedIn = "user-a";
    const tab = await createTab();

    tab.receive();
    await settle();

    expect(tab.reloads).toEqual([]);
  });

  test("a different user signed in elsewhere resets the tab once, through the session cache guard", async () => {
    signedIn = "user-a";
    const tab = await createTab();
    const guardReloads: string[] = [];
    installSessionCacheGuard(tab.queryClient, {
      isAuthFlowPage: () => false,
      reloadDocument: () => {
        guardReloads.push("reload");
      },
      reloadDocumentAt: (href) => {
        guardReloads.push(href);
      },
    });
    // The guard learns whose cache this is from a session read.
    await tab.queryClient.refetchQueries({ queryKey: sessionOptions.queryKey });

    signedIn = "user-b";
    tab.receive();
    await settle();

    expect(guardReloads).toEqual(["reload"]);
    expect(tab.reloads).toEqual([]);
  });

  test("a tab out of view reads its session at once and reloads when it is back", async () => {
    signedIn = "user-a";
    const tab = await createTab();
    tab.hide();
    const readsBefore = sessionReads;

    signedIn = null;
    tab.receive();
    await settle();
    expect(sessionReads).toBe(readsBefore + 1);
    expect(tab.reloads).toEqual([]);

    tab.show();
    await settle();
    expect(tab.reloads).toHaveLength(1);
  });

  test("a tab out of view drops its user's cached entries at once, keeping their history for them", async () => {
    signedIn = "user-a";
    const tab = await createTab();
    const local = new Map<string, string>();
    const area = {
      get length() {
        return local.size;
      },
      clear: () => {
        local.clear();
      },
      getItem: (key: string) => local.get(key) ?? null,
      key: (index: number) => [...local.keys()][index] ?? null,
      removeItem: (key: string) => {
        local.delete(key);
      },
      setItem: (key: string, value: string) => {
        local.set(key, value);
      },
    };
    installUserScopedStorage(tab.queryClient, () => ({
      local: area,
      session: null,
    }));
    await tab.queryClient.refetchQueries({ queryKey: sessionOptions.queryKey });
    area.setItem("law_search_history:u:user-a", "[]");
    area.setItem("stella.report-exports.active:u:user-a", "{}");
    tab.hide();

    signedIn = null;
    tab.receive();
    await settle();

    expect([...local.keys()]).toEqual(["law_search_history:u:user-a"]);
    expect(tab.reloads).toEqual([]);
  });

  test("a page restored from the back/forward cache reads its session again", async () => {
    signedIn = "user-a";
    const tab = await createTab();

    signedIn = null;
    tab.restore();
    await settle();

    expect(tab.reloads).toHaveLength(1);
  });
});
