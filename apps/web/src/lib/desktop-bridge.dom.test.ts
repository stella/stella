import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { DESKTOP_ACCOUNT_POLICY } from "@stll/api-contract/desktop-registry";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { captureDesktopAccountLink, stashDesktopAccountLink } =
  await import("@/lib/desktop-bridge");
const { browserStateStorage } = await import("@/lib/account/browser-storage");
const tabStorage = browserStateStorage("session");

afterEach(() => {
  tabStorage.removeItem(STORAGE_KEY);
  window.history.replaceState(null, "", "/");
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const STORAGE_KEY = "stella.desktop-account-link";
const challenge = {
  correlationId: "90123344-5566-7788-9900-aabbccddeeff",
  verifierHash: "a".repeat(64),
  deviceJkt: "A".repeat(43),
  portSecret: "b".repeat(64),
  protocol: String(DESKTOP_ACCOUNT_POLICY.linkProtocol),
};
const fragment = `#desktop-account?${new URLSearchParams(challenge).toString()}`;

// A protected-route redirect keeps only the path and query.
const redirectToSignInAndBack = () => {
  window.history.replaceState(
    null,
    "",
    "/auth?redirectTo=%2Fsettings%2Faccount%2Fdesktop",
  );
  window.history.replaceState(null, "", "/settings/account/desktop");
};

describe("desktop account link across a sign-in redirect", () => {
  test("the challenge survives the redirect and is consumed once", () => {
    window.history.replaceState(
      null,
      "",
      `/settings/account/desktop${fragment}`,
    );

    stashDesktopAccountLink();
    expect(window.location.hash).toBe("");
    expect(tabStorage.getItem(STORAGE_KEY)).not.toBeNull();

    redirectToSignInAndBack();

    expect(captureDesktopAccountLink()).toBe(true);
    expect(tabStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(captureDesktopAccountLink()).toBe(false);
  });

  test("a challenge older than its lifetime is dropped", () => {
    tabStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ hash: fragment, savedAt: 0 }),
    );
    window.history.replaceState(null, "", "/settings/account/desktop");

    expect(captureDesktopAccountLink()).toBe(false);
    expect(tabStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("a malformed stored value is ignored and removed", () => {
    tabStorage.setItem(STORAGE_KEY, "{not json");
    window.history.replaceState(null, "", "/settings/account/desktop");

    expect(captureDesktopAccountLink()).toBe(false);
    expect(tabStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("a challenge in the address bar wins and leaves history clean", () => {
    window.history.replaceState(
      null,
      "",
      `/settings/account/desktop${fragment}`,
    );

    expect(captureDesktopAccountLink()).toBe(true);
    expect(window.location.hash).toBe("");
  });

  test("pages without a challenge stash nothing", () => {
    window.history.replaceState(null, "", "/settings/account#other");

    stashDesktopAccountLink();

    expect(window.location.hash).toBe("#other");
    expect(tabStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
