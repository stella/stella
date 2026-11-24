import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { RenderResult } from "@testing-library/react";
import { panic } from "better-result";
import { afterAll, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { responseOrderProperty } from "@stll/property-testing/response-order";
import type { ResponseOrder } from "@stll/property-testing/response-order";

import type {
  AppSnapshot,
  DesktopAccountSnapshot,
  DesktopNotificationPreferences,
} from "../src/shared/rpc";

GlobalRegistrator.register({ url: "http://localhost/#notifications" });

const { act, fireEvent, render } = await import("@testing-library/react");
const { clearMocks, mockIPC, mockWindows } =
  await import("@tauri-apps/api/mocks");
const { emit } = await import("@tauri-apps/api/event");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { DesktopAppearanceProvider } =
  await import("../src/shared/use-desktop-appearance");
const { default: App } = await import("../src/mainview/App");

type PreferenceKey = keyof DesktopNotificationPreferences;

const PREFERENCE_LABELS = {
  documentReady: defaultMessages.settings.notificationDocumentReady,
  revisionCreated: defaultMessages.settings.notificationRevisionCreated,
  syncIssues: defaultMessages.settings.notificationSyncIssues,
} as const satisfies Record<PreferenceKey, string>;

const isPreferenceKey = (key: string): key is PreferenceKey =>
  key in PREFERENCE_LABELS;

const PREFERENCE_KEYS = Object.keys(PREFERENCE_LABELS).filter(isPreferenceKey);

const INITIAL_SNAPSHOT = {
  documentRecovery: {
    edits: [],
    unassigned: false,
    pending: false,
    access: "available",
  },
  bridgePort: 45_901,
  bridgeVersion: 1,
  capabilities: [],
  notificationPreferences: {
    documentReady: true,
    revisionCreated: true,
    syncIssues: true,
  },
  runningSince: "2026-09-08T05:00:00.000Z",
  sessions: [],
  trustedSelfHostConnections: [],
  update: {
    currentVersion: null,
  },
} satisfies AppSnapshot;

const ACCOUNT = {
  status: "disconnected",
  server: "https://web.example.test",
} satisfies DesktopAccountSnapshot;

const SAVE_OUTCOMES = ["saved", "failed"] as const;
type SaveOutcome = (typeof SAVE_OUTCOMES)[number];

const toggle = fc.record({
  type: fc.constant("toggle"),
  key: fc.constantFrom(...PREFERENCE_KEYS),
  outcome: fc.constantFrom(...SAVE_OUTCOMES),
});

// Two leading toggles keep at least two replies in flight; the rest
// interleaves more toggles with replies landing between them.
const steps = fc
  .tuple(
    toggle,
    toggle,
    fc.array(fc.oneof(toggle, fc.record({ type: fc.constant("release") })), {
      maxLength: 6,
    }),
  )
  .map(([first, second, rest]) => [first, second, ...rest]);

const isPreferences = (
  value: unknown,
): value is DesktopNotificationPreferences =>
  typeof value === "object" &&
  value !== null &&
  PREFERENCE_KEYS.every(
    (key) => key in value && typeof Reflect.get(value, key) === "boolean",
  );

type NativeCommand = (
  command: string,
  args: InvokeArgs | undefined,
) => Promise<unknown>;

/**
 * The native side as the window sees it: commands run in call order and each
 * change pushes `state-changed`; replies and pushes are held so the scheduler
 * picks when each lands, with pushes kept in emission order. Once closed, a
 * push still held is dropped instead of emitted, so none reaches a window that
 * was torn down.
 */
const createBackend = (order: ResponseOrder) => {
  let open = true;
  let stateReads = 0;
  let snapshot: AppSnapshot = INITIAL_SNAPSHOT;
  const pushes: AppSnapshot[] = [];
  const pushDeliveries: Promise<void>[] = [];
  const outcomes: SaveOutcome[] = [];
  const unexpected: string[] = [];
  const pushStateChanged = () => {
    pushes.push(snapshot);
    pushDeliveries.push(
      order
        .hold(
          "state-changed",
          () => pushes.shift() ?? panic("state-changed delivered twice"),
        )
        .then(async (payload) => {
          if (!open) {
            return undefined;
          }
          return await emit("state-changed", payload);
        }),
    );
  };
  const handle: NativeCommand = async (command, args) => {
    switch (command) {
      case "get_state": {
        stateReads += 1;
        const current = snapshot;
        return await order.hold("get_state", () => current);
      }
      case "update_notification_preferences": {
        const prefs: unknown = Reflect.get(args ?? {}, "prefs");
        if (!isPreferences(prefs)) {
          return panic("update_notification_preferences without prefs");
        }
        if (outcomes.shift() === "failed") {
          return await order.hold("update_notification_preferences", () => {
            throw new TypeError("Synthetic save failure");
          });
        }
        snapshot = { ...snapshot, notificationPreferences: prefs };
        pushStateChanged();
        const reply = snapshot;
        return await order.hold("update_notification_preferences", () => reply);
      }
      case "account_get_state":
        return ACCOUNT;
      // Decide whether the Activity and Dictation pages show; this account
      // has neither.
      case "is_activity_enabled":
        return false;
      case "dictation_get_snapshot":
        return { available: false };
      // Settings follows the updater from its first render.
      case "updater_state":
        return { revision: 1, state: { status: "idle" } };
      default:
        unexpected.push(command);
        return panic(`Unexpected native command: ${command}`);
    }
  };
  return {
    close: () => {
      open = false;
    },
    handle,
    drainPushes: async () => {
      await Promise.all(pushDeliveries);
    },
    expectSave: (outcome: SaveOutcome) => {
      outcomes.push(outcome);
    },
    preferences: () => snapshot.notificationPreferences,
    stateReads: () => stateReads,
    unexpected,
    unsentSaves: () => outcomes.length,
  };
};

const flushAct = async (run: () => Promise<void>) => {
  await act(async () => {
    await run();
  });
};

type Backend = ReturnType<typeof createBackend>;

// The window's event listeners live in the IPC mock, so one mock serves every
// run and each run swaps in its own backend behind it.
let backend: Backend | null = null;
mockWindows("main");
mockIPC(
  async (command, args) =>
    await (backend ?? panic(`Native command outside a run: ${command}`)).handle(
      command,
      args,
    ),
  { shouldMockEvents: true },
);

// Mounting the whole settings window is most of a run's cost, so it mounts
// once. Every later run starts it over the way a changed account does: the
// shown snapshot is dropped, every pending reply is outdated, and the state is
// read again, now from that run's backend.
let settingsWindow: RenderResult | null = null;
const startWindow = async (): Promise<RenderResult> => {
  const mounted =
    settingsWindow ??
    render(
      <DesktopIntlProvider language="en" messages={defaultMessages}>
        <DesktopAppearanceProvider
          value={{ adopt: () => undefined, appearance: "system" }}
        >
          <App />
        </DesktopAppearanceProvider>
      </DesktopIntlProvider>,
    );
  if (settingsWindow === null) {
    settingsWindow = mounted;
  } else {
    await flushAct(async () => {
      await emit("desktop-account-changed");
    });
  }
  // Unheld replies (the account read) land inside this act scope.
  await flushAct(async () => undefined);
  return mounted;
};

afterAll(async () => {
  backend?.close();
  const mounted = settingsWindow;
  if (mounted !== null) {
    await act(async () => {
      mounted.unmount();
    });
  }
  clearMocks();
  await GlobalRegistrator.unregister();
});

const rowFor = (container: HTMLElement, key: PreferenceKey) =>
  [...container.querySelectorAll('[data-slot="settings-row"]')].find(
    (element) => element.textContent.includes(PREFERENCE_LABELS[key]),
  ) ?? panic(`No notification row for ${key}`);

// The labelled native input takes the click; the visible checkbox reports state.
const toggleInput = (container: HTMLElement, key: PreferenceKey) =>
  rowFor(container, key).querySelector('input[type="checkbox"]') ??
  panic(`No checkbox input for ${key}`);

const shownChecked = (container: HTMLElement, key: PreferenceKey) =>
  rowFor(container, key)
    .querySelector('[role="checkbox"]')
    ?.getAttribute("aria-checked") === "true";

test("notification preferences show the backend's newest state in every response order", async () => {
  await assertProperty(
    "notification preferences show the backend's newest state in every response order",
    responseOrderProperty({
      scenario: steps,
      act: flushAct,
      run: async (order, scenario) => {
        const current = createBackend(order);
        backend = current;
        try {
          const view = await startWindow();
          await order.settle();
          // The window starts from this run's backend, not the last run's.
          expect(current.stateReads()).toBeGreaterThan(0);
          for (const step of scenario) {
            switch (step.type) {
              case "toggle":
                current.expectSave(step.outcome);
                await flushAct(async () => {
                  fireEvent.click(toggleInput(view.container, step.key));
                });
                // Every click must issue its save before responses are released.
                expect(current.unsentSaves()).toBe(0);
                break;
              case "release":
                await order.releaseOne();
                break;
              default:
                step satisfies never;
            }
          }
          await order.settle();
          await flushAct(current.drainPushes);
          const shown = Object.fromEntries(
            PREFERENCE_KEYS.map((key) => [
              key,
              shownChecked(view.container, key),
            ]),
          );
          expect(current.unsentSaves()).toBe(0);
          expect(shown).toEqual(current.preferences());
          expect(current.unexpected).toEqual([]);
        } finally {
          await order.settle();
          await flushAct(current.drainPushes);
          current.close();
        }
      },
    }),
    { numRuns: 60 },
  );
});
