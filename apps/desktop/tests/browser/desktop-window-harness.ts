import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import type { ActivitySettingsSnapshot } from "../../src/activity/activity-types";
import type { MicrophonesSnapshot } from "../../src/mainview/dictation-microphone";
import { ONBOARDING_STEPS } from "../../src/onboarding/onboarding-types";
import type { OnboardingSnapshot } from "../../src/onboarding/onboarding-types";
import type {
  PermissionsSnapshot,
  PermissionStatus,
} from "../../src/shared/permissions";
import type { AppSnapshot, DesktopAccountSnapshot } from "../../src/shared/rpc";
import type { ClipboardShortcutSnapshot } from "../../src/shared/shortcut-keys";
import {
  DESKTOP_WINDOW_SIZES,
  DICTATION_NOTICE_SIZE,
} from "../desktop-window-sizes";
import type { DesktopWindowSize } from "../desktop-window-sizes";
import {
  ACCOUNT,
  ACTIVITY_SETTINGS,
  APP_STATE,
  CLOUD_MODELS,
  DICTATION_READY,
  MICROPHONES,
  PERMISSIONS,
  SETTINGS_DICTATION,
  SETUP_PERMISSIONS,
  SHORTCUT,
  SIGNING_DRIVER,
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
  dictationAvailable: true,
  dictationPermissions: ["microphone", "accessibility"],
  documentApp: { iconDataUrl: null, name: "Microsoft Word" },
  linked: false,
  mode: { type: "tour" },
  step,
  steps: [...ONBOARDING_STEPS],
  // The native side reads the icon's place for the last step only.
  trayLocation: step === "done" ? { along: 0.78, edge: "top" } : null,
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
  {
    name: "introduce-dictation",
    snapshot: {
      ...tour("welcome"),
      mode: { feature: "dictation", type: "introduce" },
    },
  },
  // A taskbar along the bottom, with the icon near the clock.
  {
    name: "08-done-taskbar",
    snapshot: {
      ...tour("done"),
      trayLocation: { along: 0.94, edge: "bottom" },
    },
  },
  // An icon the OS cannot place, such as one in a hidden overflow area.
  {
    name: "08-done-unplaced",
    snapshot: { ...tour("done"), trayLocation: null },
  },
] as const satisfies readonly { name: string; snapshot: OnboardingSnapshot }[];

type WindowFixture = {
  /** The activity settings, or null while the feature is off. */
  activity: ActivitySettingsSnapshot | null;
  /** The linked account, or null when reading it fails. */
  account: DesktopAccountSnapshot | null;
  appState: AppSnapshot;
  /** The region's stella AI transcription models. */
  cloudModels: unknown;
  /** The dictation snapshot. */
  dictation: unknown;
  /** What the dictation notice panel offers, where that window is open. */
  dictationNotice?: unknown;
  /** The microphones Settings → Dictation lists. */
  microphones: MicrophonesSnapshot;
  language: string;
  onboarding: OnboardingSnapshot | null;
  permissions: PermissionsSnapshot;
  /** What the OS answers when the window asks for a permission. */
  requestOutcome: PermissionStatus;
  shortcut: ClipboardShortcutSnapshot;
  /** The smart card driver setting, or null where it is not offered. */
  signingDriver: unknown;
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
      account_get_state: async () =>
        data.account ??
        Promise.reject(new TypeError("The account could not be read.")),
      account_record_use: () => null,
      // No connection status: the section stays hidden, as with local agents off.
      chatgpt_auth_get_status: () => null,
      claude_code_auth_get_status: () => null,
      // No install status either, read the same as the refusal with local agents off.
      harness_get_status: () => null,
      local_skill_folders_get: () => null,
      signing_driver_get: () => data.signingDriver,
      local_linked_folders_get: () => null,
      desktop_report_error: () => null,
      desktop_report_timing: () => null,
      get_desktop_language: () => data.language,
      get_desktop_telemetry_enabled: () => true,
      get_state: () => data.appState,
      onboarding_get_snapshot: () => data.onboarding,
      permissions_get_snapshot: () => data.permissions,
      permissions_open_settings: () => null,
      permissions_request: (args) => {
        data.permissions = {
          rows: data.permissions.rows.map((row) =>
            row.permission === args["permission"]
              ? { ...row, status: data.requestOutcome }
              : row,
          ),
        };
        return data.permissions;
      },
      set_desktop_language: () => null,
      shortcut_get_snapshot: () => data.shortcut,
      dictation_get_snapshot: () => data.dictation,
      dictation_get_microphones: () => data.microphones,
      dictation_set_microphone: (args) => {
        const id = args["id"];
        data.microphones = {
          ...data.microphones,
          chosen: typeof id === "string" ? id : null,
        };
        return data.microphones;
      },
      dictation_test_microphone_start: () => null,
      dictation_test_microphone_stop: () => null,
      dictation_notice_get_state: () => data.dictationNotice,
      dictation_notice_respond: () => null,
      dictation_get_cloud_models: () => data.cloudModels,
      is_activity_enabled: () => data.activity !== null,
      activity_get_settings: () => data.activity,
      // Consent given, so Settings lays out its stella AI drafting rows too.
      billing_draft_get_settings: () => ({
        scopeKey: '["org_fixture","user_fixture"]',
        settings: {
          revision: "revision-1",
          effectiveMode: "plain",
          consent: "granted",
          preference: null,
        },
      }),
    }),
  });
  await page.goto(path);
};

/** Opens the setup window on one snapshot of the native flow. */
export const openOnboardingWindow = async (
  page: Page,
  snapshot: OnboardingSnapshot,
  options: WindowVariant & { requestOutcome?: PermissionStatus },
) => {
  await openWindow(page, {
    fixture: {
      account: { server: ACCOUNT.server, status: "disconnected" },
      activity: null,
      appState: APP_STATE,
      cloudModels: CLOUD_MODELS,
      dictation: DICTATION_READY,
      language: options.language,
      microphones: MICROPHONES,
      onboarding: snapshot,
      permissions: SETUP_PERMISSIONS,
      requestOutcome: options.requestOutcome ?? "granted",
      shortcut: SHORTCUT,
      signingDriver: null,
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

/** Opens the panel dictation shows when it could not hear the microphone. */
export const openDictationNoticeWindow = async (
  page: Page,
  notice: {
    fix: "chooseMicrophone" | "openSettings" | "openSound" | "request" | null;
    inputDevice: string | null;
    kind: "microphone" | "microphoneMissing" | "nothingHeard";
    missing: string | null;
  },
  options: WindowVariant,
) => {
  await openWindow(page, {
    fixture: {
      account: ACCOUNT,
      activity: null,
      appState: APP_STATE,
      cloudModels: CLOUD_MODELS,
      dictation: DICTATION_READY,
      dictationNotice: notice,
      language: options.language,
      microphones: MICROPHONES,
      onboarding: null,
      permissions: PERMISSIONS,
      requestOutcome: "granted",
      shortcut: SHORTCUT,
      signingDriver: null,
    },
    path: "/",
    platform: options.platform,
    scheme: options.scheme,
    size: DICTATION_NOTICE_SIZE,
    windowLabel: "dictation-notice",
  });
  await expect(page.getByRole("alert")).toBeVisible();
  await settle(page);
};

/** The pages every platform shows; Signing is macOS only. */
export const SETTINGS_PAGES = [
  "general",
  "dictation",
  "clipboard",
  "agents",
  "activity",
  "notifications",
  "permissions",
  "about",
] as const;

/** Pages only macOS shows. */
export const MAC_SETTINGS_PAGES = ["signing"] as const;

export type SettingsPage =
  (typeof SETTINGS_PAGES)[number] | (typeof MAC_SETTINGS_PAGES)[number];

/** Opens the settings window, linked to an account, on one page. */
export const openSettingsWindow = async (
  page: Page,
  tab: SettingsPage,
  options: WindowVariant & {
    /** Another account state than the linked fixture account. */
    account?: DesktopAccountSnapshot | null;
    /** Another inner width, such as the window's smallest. */
    width?: number;
  },
) => {
  await openWindow(page, {
    fixture: {
      account: options.account === undefined ? ACCOUNT : options.account,
      // On for every page, so each one is checked with the Activity and
      // Dictation pages in the sidebar.
      activity: ACTIVITY_SETTINGS,
      appState: APP_STATE,
      cloudModels: CLOUD_MODELS,
      dictation: SETTINGS_DICTATION,
      language: options.language,
      microphones: MICROPHONES,
      onboarding: null,
      permissions: PERMISSIONS,
      requestOutcome: "granted",
      shortcut: SHORTCUT,
      signingDriver: SIGNING_DRIVER,
    },
    path: `/#${tab}`,
    platform: options.platform,
    scheme: options.scheme,
    size: {
      ...DESKTOP_WINDOW_SIZES.settings,
      width: options.width ?? DESKTOP_WINDOW_SIZES.settings.width,
    },
    windowLabel: "main",
  });
  await expect(
    page.locator(`[data-slot=settings-page][data-page=${tab}]`),
  ).toBeVisible();
  // Every page reads its data from the native side before it settles.
  if (tab === "general" && options.account === undefined) {
    await expect(page.getByText(ACCOUNT.account.email)).toBeVisible();
    await expect(page.getByRole("switch").first()).toBeVisible();
  }
  if (tab === "activity") {
    await expect(
      page.getByRole("listitem").filter({ hasText: "Example Editor" }),
    ).toBeVisible();
  }
  if (tab === "notifications") {
    await expect(page.getByRole("checkbox").first()).toBeEnabled();
  }
  if (tab === "dictation") {
    const pane = page.locator("[data-slot=settings-page]");
    await expect(pane.getByRole("alert")).toBeVisible();
    // Cleanup and both of its context switches, all switchable.
    await expect(
      pane.locator("[data-slot=settings-row] [role=switch]"),
    ).toHaveCount(3);
    await expect(
      pane.locator("[data-slot=settings-row][data-disabled]"),
    ).toHaveCount(0);
  }
  if (tab === "signing") {
    await expect(
      page.locator("[data-slot=settings-page] [data-slot=list] button").first(),
    ).toBeVisible();
  }
  if (tab === "permissions") {
    await expect(page.locator("[data-permission]").first()).toBeVisible();
  }
  await settle(page);
};

/** Waits for fonts, the language catalogue and every animation that ends.
 * A looping animation, such as a loading skeleton, never finishes; one
 * cancelled because its element left the page has settled. */
const settle = async (page: Page) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().endTime !== Infinity,
        )
        .map(async (animation) =>
          animation.finished.catch((error: unknown) => {
            if (!(
              error instanceof DOMException && error.name === "AbortError"
            )) {
              throw error;
            }
          }),
        ),
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
      // Text that ends in an ellipsis is cut on purpose, by its own box:
      // what a reader sees is that box.
      const ownerStyle = getComputedStyle(owner);
      const ellipsized =
        ownerStyle.textOverflow === "ellipsis" && clips(ownerStyle, "x");
      check(
        ellipsized
          ? owner.getBoundingClientRect()
          : range.getBoundingClientRect(),
        owner,
        `text ${label(node)}`,
      );
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
 * and fields alike, measured on the box a reader sees. Switches, checkboxes,
 * tabs and the items of a segmented control have scales of their own, and a
 * fact with a tooltip is text, not a control.
 */
export const controlMetrics = async (page: Page, scope: string) =>
  await page.evaluate(
    (container) =>
      [
        ...document.querySelectorAll(
          `${container} button:not([role=switch], [role=checkbox], [role=tab], [data-slot=toggle-group-item], [data-slot=tooltip-trigger].decoration-dotted), ${container} [data-slot=input-control]`,
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
      "[data-slot=scroll-area-viewport]:has([data-slot=settings-page])",
    );
    if (!viewport || viewport.scrollHeight <= viewport.clientHeight) {
      return false;
    }
    viewport.scrollTop = viewport.scrollHeight;
    return true;
  });
