import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import type { DesktopAccountSnapshot } from "../../src/shared/rpc";
import { SETTINGS_WINDOW_MIN_WIDTH } from "../desktop-window-sizes";
import {
  openSettingsWindow,
  unexpectedNativeCalls,
} from "./desktop-window-harness";
import { ACCOUNT } from "./fixtures/desktop-window-snapshots";

test.use({ deviceScaleFactor: 2 });

test.afterEach(async ({ page }) => {
  expect(await unexpectedNativeCalls(page)).toEqual([]);
});

const LONG_HOST = "stella.legal-department.long-example-firm.example.test";

/** Every account state the sidebar draws a status line for. */
const ACCOUNT_STATES = [
  { name: "linked", account: ACCOUNT },
  { name: "expired", account: { server: ACCOUNT.server, status: "expired" } },
  {
    name: "attention",
    account: { server: ACCOUNT.server, status: "reconnectRequired" },
  },
  {
    name: "not linked",
    account: { server: ACCOUNT.server, status: "disconnected" },
  },
  // Reading the account failed: a status without a host.
  { name: "unavailable", account: null },
] as const satisfies readonly {
  name: string;
  account: DesktopAccountSnapshot | null;
}[];

const withServer = (
  account: DesktopAccountSnapshot | null,
  server: string,
): DesktopAccountSnapshot | null =>
  account === null ? null : { ...account, server };

/** The status line's box, its children's tops, and what was cut. */
const statusLine = async (page: Page) =>
  page.locator("[data-slot=sidebar-account-status]").evaluate((line) => {
    // Every run of text: the status, the separator and the host.
    const tops = [...line.querySelectorAll("*")]
      .filter(
        (element) =>
          element.children.length === 0 &&
          element.textContent.trim() !== "" &&
          element.getClientRects().length > 0,
      )
      .map((element) => Math.round(element.getBoundingClientRect().top));
    const host = line.querySelector<HTMLElement>(
      "[data-slot=sidebar-account-host]",
    );
    const status = line.querySelector<HTMLElement>(
      "[data-slot=truncated-text]:not([data-slot=sidebar-account-host])",
    );
    const lineHeight = Number.parseFloat(getComputedStyle(line).lineHeight);
    return {
      height: line.getBoundingClientRect().height,
      hostCut: host === null ? null : host.scrollWidth > host.clientWidth,
      lineHeight,
      rows: new Set(tops).size,
      statusCut:
        status === null ? null : status.scrollWidth > status.clientWidth,
    };
  });

for (const { name, account } of ACCOUNT_STATES) {
  for (const width of [SETTINGS_WINDOW_MIN_WIDTH, 760]) {
    test(`the sidebar's ${name} status stays on one row with a long host at ${width} px`, async ({
      page,
    }) => {
      await openSettingsWindow(page, "about", {
        account: withServer(account, `https://${LONG_HOST}`),
        language: "en",
        platform: "mac",
        scheme: "light",
        width,
      });
      await expect(
        page.locator("[data-slot=sidebar-account-status]"),
      ).toBeVisible();

      const line = await statusLine(page);
      expect(line.rows, JSON.stringify(line)).toBe(1);
      expect(line.height).toBeLessThanOrEqual(line.lineHeight + 1);
      // The host gives way; the status word stays whole.
      expect(line.statusCut).toBe(false);
      expect(line.hostCut).toBe(account === null ? null : true);
    });
  }
}

test("the sidebar names the usual host whole on one row", async ({ page }) => {
  await openSettingsWindow(page, "about", {
    account: { ...ACCOUNT, server: "https://my.stll.app" },
    language: "en",
    platform: "mac",
    scheme: "light",
    width: SETTINGS_WINDOW_MIN_WIDTH,
  });
  const host = page.locator("[data-slot=sidebar-account-host]");
  await expect(host).toHaveText("my.stll.app");

  const line = await statusLine(page);
  expect(line.rows, JSON.stringify(line)).toBe(1);
  expect(line.hostCut).toBe(false);
});

test("a cut host shows whole in a tooltip", async ({ page }) => {
  await openSettingsWindow(page, "about", {
    account: { ...ACCOUNT, server: `https://${LONG_HOST}` },
    language: "en",
    platform: "mac",
    scheme: "light",
    width: SETTINGS_WINDOW_MIN_WIDTH,
  });

  await page.locator("[data-slot=sidebar-account-host]").hover();

  await expect(page.locator("[data-slot=tooltip-popup]")).toHaveText(LONG_HOST);
});
