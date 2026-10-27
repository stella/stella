import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { TimeEntrySuggestion } from "@stll/api-contract/time-entry-types";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { TimeSuggestionRow } = await import("./time-suggestion-row");

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

const suggestion: TimeEntrySuggestion = {
  fingerprint: "suggestion",
  startedAt: "2026-10-24T09:00:00.000Z",
  endedAt: "2026-10-24T09:07:00.000Z",
  durationMinutes: 15,
  engagedMinutes: 7,
  alreadyCovered: false,
  billableByDefault: true,
  signalCount: 1,
  evidence: [
    {
      type: "chat_thread",
      id: "thread",
      title: "Lease review",
      messageCount: 1,
      signals: [
        {
          source: "chat_message",
          resourceId: "message",
          timestamp: "2026-10-24T09:00:00.000Z",
        },
      ],
    },
  ],
};

const renderRow = () => {
  const calls: string[] = [];
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en-GB" timeZone="UTC">
        <ul>
          <TimeSuggestionRow
            busy={false}
            onAccept={() => calls.push("accept")}
            onDismiss={() => calls.push("dismiss")}
            onEdit={() => calls.push("edit")}
            suggestion={suggestion}
          />
        </ul>
      </FormattingProvider>
    </IntlProvider>,
  );
  const body = view.getByRole("button", {
    name: new RegExp(`^${messages.common.accept}`, "u"),
  });
  return { body, calls };
};

test("the row answers its plain shortcuts once per press", () => {
  const { body, calls } = renderRow();

  fireEvent.keyDown(body, { key: "e" });
  fireEvent.keyDown(body, { key: "Backspace" });

  expect(calls).toEqual(["edit", "dismiss"]);
  expect(body.getAttribute("aria-keyshortcuts")).toBe(
    "Enter E Delete Backspace",
  );
});

test("command chords, modified deletes and held keys leave the row alone", () => {
  const { body, calls } = renderRow();

  // Command chords and modified deletes belong to the browser.
  fireEvent.keyDown(body, { key: "e", ctrlKey: true });
  fireEvent.keyDown(body, { key: "e", metaKey: true });
  fireEvent.keyDown(body, { key: "Delete", altKey: true });
  fireEvent.keyDown(body, { key: "Backspace", ctrlKey: true });
  fireEvent.keyDown(body, { key: "Delete", metaKey: true });
  // A held key repeats; only its first press counts.
  fireEvent.keyDown(body, { key: "Delete", repeat: true });

  expect(calls).toEqual([]);
});
