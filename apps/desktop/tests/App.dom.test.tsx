import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";
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
const { default: App } = await import("../src/mainview/App");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

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
    baseUrl: null,
    channel: null,
    currentHash: null,
    currentVersion: null,
    lastCheckedAt: null,
    latestHash: null,
    latestVersion: null,
    status: "idle",
    statusMessage: "",
    updateAvailable: false,
    updateReady: false,
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

/**
 * The native side as the window sees it: commands run in call order and each
 * change pushes `state-changed`; replies and pushes are held so the scheduler
 * picks when each lands, with pushes kept in emission order.
 */
const installBackend = (order: ResponseOrder) => {
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
        .then(async (payload) => await emit("state-changed", payload)),
    );
  };
  mockWindows("main");
  mockIPC(
    async (command, args) => {
      switch (command) {
        case "get_state": {
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
          return await order.hold(
            "update_notification_preferences",
            () => reply,
          );
        }
        case "account_get_state":
          return ACCOUNT;
        default:
          unexpected.push(command);
          return panic(`Unexpected native command: ${command}`);
      }
    },
    { shouldMockEvents: true },
  );
  return {
    drainPushes: async () => {
      await Promise.all(pushDeliveries);
    },
    expectSave: (outcome: SaveOutcome) => {
      outcomes.push(outcome);
    },
    preferences: () => snapshot.notificationPreferences,
    unexpected,
    unsentSaves: () => outcomes.length,
  };
};

const rowFor = (container: HTMLElement, key: PreferenceKey) =>
  [...container.querySelectorAll("label")].find((element) =>
    element.textContent.includes(PREFERENCE_LABELS[key]),
  ) ?? panic(`No notification row for ${key}`);

// The labelled native input takes the click; the visible checkbox reports state.
const toggleInput = (container: HTMLElement, key: PreferenceKey) =>
  rowFor(container, key).querySelector('input[type="checkbox"]') ??
  panic(`No checkbox input for ${key}`);

const shownChecked = (container: HTMLElement, key: PreferenceKey) =>
  rowFor(container, key)
    .querySelector('[role="checkbox"]')
    ?.getAttribute("aria-checked") === "true";

const flushAct = async (run: () => Promise<void>) => {
  await act(async () => {
    await run();
  });
};

test(
  "notification preferences show the backend's newest state in every response order",
  async () => {
    await assertProperty(
      "notification preferences show the backend's newest state in every response order",
      responseOrderProperty({
        scenario: steps,
        act: flushAct,
        run: async (order, scenario) => {
          const backend = installBackend(order);
          const view = render(
            <DesktopIntlProvider language="en" messages={defaultMessages}>
              <App />
            </DesktopIntlProvider>,
          );
          try {
            // Unheld replies (the account read) land inside this act scope.
            await flushAct(async () => undefined);
            await order.settle();
            for (const step of scenario) {
              switch (step.type) {
                case "toggle":
                  backend.expectSave(step.outcome);
                  await flushAct(async () => {
                    fireEvent.click(toggleInput(view.container, step.key));
                  });
                  // Every click must issue its save before responses are released.
                  expect(backend.unsentSaves()).toBe(0);
                  break;
                case "release":
                  await order.releaseOne();
                  break;
                default:
                  step satisfies never;
              }
            }
            await order.settle();
            await flushAct(backend.drainPushes);
            const shown = Object.fromEntries(
              PREFERENCE_KEYS.map((key) => [
                key,
                shownChecked(view.container, key),
              ]),
            );
            expect(backend.unsentSaves()).toBe(0);
            expect(shown).toEqual(backend.preferences());
            expect(backend.unexpected).toEqual([]);
          } finally {
            await order.settle();
            await flushAct(backend.drainPushes);
            await flushAct(async () => {
              view.unmount();
            });
            clearMocks();
          }
        },
      }),
      { numRuns: 60 },
    );
  },
  propertyTestTimeout(60_000),
);
