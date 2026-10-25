import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { TimeSuggestionsLane } = await import("./time-suggestions-lane");

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

test("shows rounded billed time with raw engaged time", () => {
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en-GB" timeZone="UTC">
        <TimeSuggestionsLane
          activeMinutes={15}
          busyFingerprints={new Set()}
          items={[
            {
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
                },
              ],
            },
          ]}
          loggedMinutes={0}
          onAccept={() => undefined}
          onDismiss={() => undefined}
          onEdit={() => undefined}
        />
      </FormattingProvider>
    </IntlProvider>,
  );

  expect(view.getByText("15 min")).toBeTruthy();
  expect(view.getByText("7 min engaged")).toBeTruthy();
});
