import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  ACTIVITY_CHANGED_EVENT,
  isActivityDaySnapshot,
} from "../../src/activity/activity-types";
import type { ActivityDaySnapshot } from "../../src/activity/activity-types";
import enMessages from "../../src/i18n/langs/en.json" with { type: "json" };

const SNAPSHOT = {
  date: "2026-10-07",
  earliestDate: "2026-10-01",
  excludedApps: [],
  persistence: "encrypted",
  recordingStatus: "recording",
  retention: "month",
  segments: [
    {
      appIdentifier: "com.example.editor",
      appName: "Example Editor",
      start: "2026-10-07T09:00:00Z",
      end: "2026-10-07T09:30:00Z",
    },
  ],
  today: "2026-10-07",
  unreadable: false,
} satisfies ActivityDaySnapshot;

const installNativeBoundary = async (page: Page) => {
  expect(isActivityDaySnapshot(SNAPSHOT)).toBe(true);
  await page.addInitScript(
    ({ snapshot, changedEvent }) => {
      const callbacks = new Map<number, (data: unknown) => unknown>();
      const invocations: { args: Record<string, unknown>; command: string }[] =
        [];
      let nextCallbackId = 1;
      Reflect.set(window, "__STELLA_TEST_INVOCATIONS__", invocations);
      Reflect.set(window, "__STELLA_TEST_ACTIVITY_CHANGED__", () => {
        const subscription = invocations.findLast(
          ({ args, command }) =>
            command === "plugin:event|listen" && args["event"] === changedEvent,
        );
        const id = subscription?.args["handler"];
        if (typeof id !== "number") {
          throw new TypeError("Activity listener is not installed");
        }
        callbacks.get(id)?.({ event: changedEvent, id, payload: null });
      });
      Reflect.set(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
        unregisterListener: () => undefined,
      });
      Reflect.set(window, "__TAURI_INTERNALS__", {
        callbacks,
        convertFileSrc: (path: string) => path,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          invocations.push({ args, command });
          if (command === "activity_get_day") {
            return { ...snapshot, date: args["date"] ?? snapshot.date };
          }
          if (command === "get_desktop_language") {
            return "en";
          }
          if (command === "plugin:event|listen") {
            return args["handler"];
          }
          return undefined;
        },
        metadata: {
          currentWebview: { label: "activity", windowLabel: "activity" },
          currentWindow: { label: "activity" },
        },
        runCallback: (id: number, data: unknown) => callbacks.get(id)?.(data),
        transformCallback: (
          callback: ((data: unknown) => unknown) | undefined,
          once = false,
        ) => {
          const id = nextCallbackId;
          nextCallbackId += 1;
          callbacks.set(id, (data) => {
            if (once) {
              callbacks.delete(id);
            }
            return callback?.(data);
          });
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
      });
    },
    { snapshot: SNAPSHOT, changedEvent: ACTIVITY_CHANGED_EVENT },
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: enMessages.activity.copySummary }),
  ).toBeVisible();
};

const invocations = (page: Page) =>
  page.evaluate(() => {
    const calls: unknown = Reflect.get(window, "__STELLA_TEST_INVOCATIONS__");
    return calls;
  });

for (const history of ["keep", "delete"] as const) {
  test(`excluding an app waits for the ${history} history choice`, async ({
    page,
  }) => {
    await installNativeBoundary(page);
    await page
      .getByRole("button", { name: "Stop recording Example Editor" })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await invocations(page)).not.toContainEqual(
      expect.objectContaining({ command: "activity_exclude_app" }),
    );
    await page
      .getByRole("button", {
        name:
          history === "keep"
            ? enMessages.activity.keepHistory
            : enMessages.activity.deleteHistory,
      })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await invocations(page)).toContainEqual({
      command: "activity_exclude_app",
      args: {
        identifier: "com.example.editor",
        name: "Example Editor",
        history,
      },
    });
  });
}

test("canceling exclusion leaves recording and history unchanged", async ({
  page,
}) => {
  await installNativeBoundary(page);
  await page
    .getByRole("button", { name: "Stop recording Example Editor" })
    .click();
  await page.getByRole("button", { name: enMessages.activity.cancel }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(await invocations(page)).not.toContainEqual(
    expect.objectContaining({ command: "activity_exclude_app" }),
  );
});

test("only an explicit summary copy publishes activity to the clipboard", async ({
  page,
}) => {
  await installNativeBoundary(page);
  await page.evaluate(() => {
    const changed: unknown = Reflect.get(
      window,
      "__STELLA_TEST_ACTIVITY_CHANGED__",
    );
    if (typeof changed !== "function") {
      throw new TypeError("Activity event fixture is missing");
    }
    changed();
  });
  await page
    .getByRole("button", { name: enMessages.activity.previousDay })
    .click();
  await expect(
    page.getByRole("button", { name: enMessages.activity.nextDay }),
  ).toBeEnabled();
  const callsBeforeCopy = await invocations(page);
  expect(callsBeforeCopy).not.toContainEqual(
    expect.objectContaining({ command: "activity_copy_text" }),
  );
  expect(callsBeforeCopy).not.toContainEqual(
    expect.objectContaining({ command: expect.stringContaining("clipboard_") }),
  );
  await page
    .getByRole("button", { name: enMessages.activity.copySummary })
    .click();
  await expect(
    page.getByRole("button", { name: enMessages.activity.copied }),
  ).toBeVisible();
  const callsAfterCopy = await invocations(page);
  expect(callsAfterCopy).toContainEqual({
    command: "activity_copy_text",
    args: { text: expect.stringContaining("Example Editor") },
  });
  expect(
    Array.isArray(callsAfterCopy)
      ? callsAfterCopy.filter(
          (call: unknown) =>
            typeof call === "object" &&
            call !== null &&
            "command" in call &&
            call.command === "activity_copy_text",
        )
      : [],
  ).toHaveLength(1);
});
