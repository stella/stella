import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import {
  drainReactScheduler,
  unregisterDomEnvironment,
} from "@stll/property-testing/dom-environment";

import type { DesktopAccountSnapshot } from "../src/shared/rpc";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, render, waitFor } =
  await import("@testing-library/react");
const { AccountAvatar } = await import("../src/mainview/AccountAvatar");
const { accountDisplay } = await import("../src/mainview/account-presentation");

afterEach(async () => {
  await act(async () => {
    await drainReactScheduler();
  });
  cleanup();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

// A 1×1 PNG, the shape the native side sends.
const PICTURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

const connected = (avatar: string | null) =>
  ({
    account: {
      email: "eliska.novakova@example.test",
      name: "Eliška Nováková",
      verifiedAt: "2026-10-27T07:30:00.000Z",
    },
    avatar,
    expiresAt: "2026-11-26T07:30:00.000Z",
    identity: { organizationId: "organization-1", userId: "user-1" },
    server: "https://app.example.test",
    status: "connected",
  }) satisfies DesktopAccountSnapshot;

const renderAvatar = (avatar: string | null) => {
  const display = accountDisplay(connected(avatar));
  return { display, view: render(<AccountAvatar display={display} />) };
};

test("an account without a picture shows its initials and no image", async () => {
  const { view } = renderAvatar(null);
  await act(async () => {
    await drainReactScheduler();
  });
  expect(view.getByText("EN")).toBeTruthy();
  expect(view.container.querySelector("img")).toBeNull();
});

test("a picture that loads replaces the initials", async () => {
  const { display, view } = renderAvatar(PICTURE);
  expect(display.avatar).toBe(PICTURE);
  await waitFor(() => {
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      PICTURE,
    );
  });
  expect(view.queryByText("EN")).toBeNull();
});

test("a picture that fails to load leaves the initials", async () => {
  // Well formed, so it reaches the image, but no image decodes from it.
  const broken = "data:image/png;base64,AAAA";
  const { display, view } = renderAvatar(broken);
  expect(display.avatar).toBe(broken);
  await act(async () => {
    await drainReactScheduler();
  });
  expect(view.getByText("EN")).toBeTruthy();
  expect(view.container.querySelector("img")).toBeNull();
});

test("a picture the webview may not load is never handed to it", () => {
  for (const unsafe of [
    "https://images.example.test/member.png",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:text/html;base64,PGh0bWw+",
    `${PICTURE}"onerror="x`,
  ]) {
    expect([unsafe, accountDisplay(connected(unsafe)).avatar]).toEqual([
      unsafe,
      null,
    ]);
  }
  expect(accountDisplay({ status: "loading" }).avatar).toBeNull();
});
