import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { ONBOARDING_STEPS } from "../../src/onboarding/onboarding-types";
import type { OnboardingSnapshot } from "../../src/onboarding/onboarding-types";
import type { PermissionsSnapshot } from "../../src/shared/permissions";
import type { AppSnapshot, DesktopAccountSnapshot } from "../../src/shared/rpc";
import type { ClipboardShortcutSnapshot } from "../../src/shared/shortcut-keys";
import { DESKTOP_WINDOW_SIZES } from "../desktop-window-sizes";
import type { DesktopWindowSize } from "../desktop-window-sizes";
import {
  ACCOUNT,
  APP_STATE,
  PERMISSIONS,
  SHORTCUT,
} from "./fixtures/desktop-window-snapshots";
import {
  installTauriIpc,
  tauriInvocations,
  unexpectedTauriCalls,
} from "./tauri-ipc";

/**
 * Drives the settings and setup windows without Tauri: the page is the real
 * app entry, the native side answers from fixed, realistic snapshots, and
 * the viewport is the window's native size.
 */

/** The platform decides copy, title-bar insets and modifier order. */
const DESKTOP_USER_AGENTS = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
} as const;

export type DesktopTestPlatform = keyof typeof DESKTOP_USER_AGENTS;

/** The smallest distance any text or control keeps from a window edge. */
export const WINDOW_EDGE_INSET = 16;

export type WindowVariant = {
  language: string;
  platform: DesktopTestPlatform;
  scheme: "dark" | "light";
};

/** The variants every window is checked in. */
export const WINDOW_VARIANTS = [
  { language: "en", platform: "mac", scheme: "light" },
  { language: "en", platform: "mac", scheme: "dark" },
  // The widest catalogue, so copy that only just fits in English is caught.
  { language: "de", platform: "mac", scheme: "light" },
  // The tallest: its activity step needs the most height.
  { language: "fr", platform: "mac", scheme: "light" },
  { language: "en", platform: "windows", scheme: "light" },
] as const satisfies readonly WindowVariant[];

const tour = (step: OnboardingSnapshot["step"]): OnboardingSnapshot => ({
  activityAvailable: true,
  activityPermissions: ["accessibility"],
  documentApp: { iconDataUrl: null, name: "Microsoft Word" },
  linked: false,
  mode: { type: "tour" },
  step,
  steps: [...ONBOARDING_STEPS],
});

/** Every screen the setup window shows: the tour's steps and both other modes. */
export const ONBOARDING_SCREENS = [
  ...ONBOARDING_STEPS.map((step, index) => ({
    name: `${String(index + 1).padStart(2, "0")}-${step}`,
    snapshot: tour(step),
  })),
  {
    name: "fix",
    snapshot: {
      ...tour("welcome"),
      mode: { permissions: ["accessibility", "notifications"], type: "fix" },
    },
  },
  {
    name: "introduce",
    snapshot: {
      ...tour("welcome"),
      mode: { feature: "activityTimeline", type: "introduce" },
    },
  },
] as const satisfies readonly { name: string; snapshot: OnboardingSnapshot }[];

type WindowFixture = {
  account: DesktopAccountSnapshot;
  appState: AppSnapshot;
  language: string;
  onboarding: OnboardingSnapshot | null;
  permissions: PermissionsSnapshot;
  shortcut: ClipboardShortcutSnapshot;
};

const openWindow = async (
  page: Page,
  {
    fixture,
    path,
    platform,
    scheme,
    size,
    windowLabel,
  }: {
    fixture: WindowFixture;
    path: string;
    platform: DesktopTestPlatform;
    scheme: "dark" | "light";
    size: DesktopWindowSize;
    windowLabel: string;
  },
) => {
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
  await page.addInitScript((userAgent) => {
    Object.defineProperty(navigator, "userAgent", { get: () => userAgent });
  }, DESKTOP_USER_AGENTS[platform]);
  await installTauriIpc(page, {
    windowLabel,
    unhandled: "rejectAsUnexpected",
    arg: fixture,
    handlers: (data) => ({
      account_get_state: () => data.account,
      account_record_use: () => null,
      desktop_report_error: () => null,
      desktop_report_timing: () => null,
      get_desktop_language: () => data.language,
      get_desktop_telemetry_enabled: () => true,
      get_state: () => data.appState,
      onboarding_get_snapshot: () => data.onboarding,
      permissions_get_snapshot: () => data.permissions,
      set_desktop_language: () => null,
      shortcut_get_snapshot: () => data.shortcut,
    }),
  });
  await page.goto(path);
};

/** Opens the setup window on one snapshot of the native flow. */
export const openOnboardingWindow = async (
  page: Page,
  snapshot: OnboardingSnapshot,
  options: WindowVariant,
) => {
  await openWindow(page, {
    fixture: {
      account: { server: ACCOUNT.server, status: "disconnected" },
      appState: APP_STATE,
      language: options.language,
      onboarding: snapshot,
      permissions: PERMISSIONS,
      shortcut: SHORTCUT,
    },
    path: "/",
    platform: options.platform,
    scheme: options.scheme,
    size: DESKTOP_WINDOW_SIZES.onboarding,
    windowLabel: "onboarding",
  });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await settle(page);
};

export const SETTINGS_TABS = ["general", "notifications", "about"] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** Opens the settings window, linked to an account, on one tab. */
export const openSettingsWindow = async (
  page: Page,
  tab: SettingsTab,
  options: WindowVariant,
) => {
  await openWindow(page, {
    fixture: {
      account: ACCOUNT,
      appState: APP_STATE,
      language: options.language,
      onboarding: null,
      permissions: PERMISSIONS,
      shortcut: SHORTCUT,
    },
    path: `/#${tab}`,
    platform: options.platform,
    scheme: options.scheme,
    size: DESKTOP_WINDOW_SIZES.settings,
    windowLabel: "main",
  });
  await expect(page.getByRole("tabpanel")).toBeVisible();
  // Every tab reads its data from the native side before it settles.
  if (tab === "general") {
    await expect(page.getByText(ACCOUNT.account.email)).toBeVisible();
    await expect(page.getByRole("switch").first()).toBeVisible();
  }
  if (tab === "notifications") {
    await expect(page.getByRole("checkbox").first()).toBeEnabled();
  }
  await settle(page);
};

/** Waits for fonts, the language catalogue and any running animation. */
const settle = async (page: Page) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document.getAnimations().map(async (animation) => animation.finished),
    );
  });
};

/** The native calls a window made that its fixture did not expect. */
export const unexpectedNativeCalls = async (page: Page) => [
  ...(await unexpectedTauriCalls(page)),
  ...(await tauriInvocations(page))
    .filter(({ command }) => command === "desktop_report_error")
    .map(({ args }) => `desktop_report_error ${JSON.stringify(args)}`),
];

/**
 * Every visible text run and control, checked against the window it sits
 * in: kept `inset` pixels from each window edge, not cut off by an ancestor
 * that hides overflow, and no page scroll in a fixed-size window. Content
 * inside a scrolling region may sit below its fold, but not beside it.
 */
export const windowGeometryViolations = async (page: Page, inset: number) =>
  await page.evaluate((minimum) => {
    const violations: string[] = [];
    const width = window.innerWidth;
    const height = window.innerHeight;
    const root = document.documentElement;
    if (root.scrollWidth > width) {
      violations.push(`page scrolls sideways: ${root.scrollWidth}px wide`);
    }
    if (root.scrollHeight > height) {
      violations.push(`page scrolls: ${root.scrollHeight}px tall`);
    }

    const round = (value: number) => Math.round(value * 10) / 10;
    const label = (node: Node) =>
      JSON.stringify(
        (
          node.textContent ||
          (node instanceof Element ? node.getAttribute("aria-label") : "") ||
          (node instanceof Element ? node.tagName.toLowerCase() : "")
        )
          .trim()
          .slice(0, 48),
      );
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) {
        return false;
      }
      for (
        let current: Element | null = element;
        current;
        current = current.parentElement
      ) {
        const style = getComputedStyle(current);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.opacity === "0"
        ) {
          return false;
        }
      }
      return true;
    };
    const scrolls = (style: CSSStyleDeclaration, axis: "x" | "y") => {
      const overflow = axis === "x" ? style.overflowX : style.overflowY;
      return overflow === "auto" || overflow === "scroll";
    };
    const clips = (style: CSSStyleDeclaration, axis: "x" | "y") =>
      (axis === "x" ? style.overflowX : style.overflowY) !== "visible";

    const check = (rect: DOMRect, owner: Element, what: string) => {
      if (rect.width === 0 || rect.height === 0) {
        return;
      }
      const edge = (side: string, distance: number) => {
        if (distance < minimum - 0.5) {
          violations.push(
            `${what} sits ${round(distance)}px from the window's ${side} edge`,
          );
        }
      };
      let scrollRegion: Element | null = null;
      for (
        let ancestor = owner.parentElement;
        ancestor && ancestor !== root;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor);
        const box = ancestor.getBoundingClientRect();
        const scrollsY =
          scrolls(style, "y") && ancestor.scrollHeight > ancestor.clientHeight;
        if (
          clips(style, "x") &&
          (rect.left < box.left - 0.5 || rect.right > box.right + 0.5)
        ) {
          violations.push(`${what} is cut off sideways by its container`);
          return;
        }
        if (
          clips(style, "y") &&
          !scrollsY &&
          // Content a scrolling region holds is clipped by it on purpose.
          scrollRegion === null &&
          (rect.top < box.top - 0.5 || rect.bottom > box.bottom + 0.5)
        ) {
          violations.push(`${what} is cut off vertically by its container`);
          return;
        }
        if (scrollsY && scrollRegion === null) {
          scrollRegion = ancestor;
        }
      }
      edge("left", rect.left);
      edge("right", width - rect.right);
      if (scrollRegion === null) {
        edge("top", rect.top);
        edge("bottom", height - rect.bottom);
        return;
      }
      const region = scrollRegion.getBoundingClientRect();
      edge("top", region.top);
      edge("bottom", height - region.bottom);
    };

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const owner = node.parentElement;
      if (!owner || !node.textContent?.trim() || !visible(owner)) {
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      check(range.getBoundingClientRect(), owner, `text ${label(node)}`);
    }
    for (const control of document.querySelectorAll(
      "button, input, img, svg, [role=switch], [role=checkbox], [role=combobox], [role=tab]",
    )) {
      if (visible(control) && !control.parentElement?.closest("svg")) {
        check(
          control.getBoundingClientRect(),
          control,
          `${control.tagName.toLowerCase()} ${label(control)}`,
        );
      }
    }
    return [...new Set(violations)];
  }, inset);

/**
 * The height and type size of every text control inside `scope`, buttons
 * and fields alike, measured on the box a reader sees. Switches, checkboxes
 * and tabs have scales of their own.
 */
export const controlMetrics = async (page: Page, scope: string) =>
  await page.evaluate(
    (container) =>
      [
        ...document.querySelectorAll(
          `${container} button:not([role=switch], [role=checkbox], [role=tab]), ${container} [data-slot=input-control]`,
        ),
      ]
        .filter((control) => control.getBoundingClientRect().height > 1)
        .map((control) => {
          const input = control.querySelector("input");
          const height = Math.round(control.getBoundingClientRect().height);
          const { fontSize } = getComputedStyle(input ?? control);
          return {
            control: (control.textContent || input?.value || "").trim(),
            scale: `${height}px ${fontSize}`,
          };
        }),
    scope,
  );

/** Scrolls the open settings pane to its end; false when it fits. */
export const scrollSettingsPaneToEnd = async (page: Page) =>
  await page.evaluate(() => {
    const viewport = document.querySelector(
      "[role=tabpanel] [data-slot=scroll-area-viewport]",
    );
    if (!viewport || viewport.scrollHeight <= viewport.clientHeight) {
      return false;
    }
    viewport.scrollTop = viewport.scrollHeight;
    return true;
  });
