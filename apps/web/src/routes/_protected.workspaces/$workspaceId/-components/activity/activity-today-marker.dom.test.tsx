import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import englishMessages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { HorizontalTodayMarker } = await import("./activity-today-marker");

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

test("the timeline's Today marker does not use the destructive color", () => {
  const { container, getByText } = render(
    <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
      <HorizontalTodayMarker />
    </IntlProvider>,
  );

  expect(getByText(englishMessages.common.today)).toBeDefined();
  const destructive = container.querySelectorAll(
    "[class*='text-destructive'], [class*='bg-destructive']",
  );
  expect(destructive).toHaveLength(0);
});
