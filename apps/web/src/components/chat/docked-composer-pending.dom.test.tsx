import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register();

const { cleanup, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { DockedComposerPending } = await import("./docked-composer");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(() => {
  cleanup();
});

afterAll(() => {
  unregisterDomEnvironment();
});

const expectLoadingAnnounced = (
  surface: Parameters<typeof DockedComposerPending>[0]["surface"],
) => {
  const { container, getByRole } = render(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <DockedComposerPending surface={surface} />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

  // The bar is hidden, so a status inside it would never be announced.
  expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  const status = getByRole("status");
  expect(status.textContent).toBe(messages.common.loading);
  expect(status.closest('[aria-hidden="true"]')).toBeNull();
};

test("the chat placeholder tells assistive technology it is loading", () => {
  expectLoadingAnnounced("chat");
});

test("the sign-in placeholder tells assistive technology it is loading", () => {
  expectLoadingAnnounced("sign-in");
});
