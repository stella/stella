import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ChatRanOnModel } = await import("@/components/chat/chat-ran-on-model");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(cleanup);
afterAll(async () => unregisterDomEnvironment());

const view = (metadata: Parameters<typeof ChatRanOnModel>[0]["metadata"]) => (
  <IntlProvider locale="en" messages={messages} timeZone="UTC">
    <ChatRanOnModel metadata={metadata} />
  </IntlProvider>
);

test("an answer the harness rerouted says the model it ran on", () => {
  const rendered = render(
    view({ localRunModel: { requested: "gpt-5.5", ran: "gpt-5.4" } }),
  );
  expect(rendered.container.textContent).toBe("Ran on gpt-5.4");
});

test("an answer that ran on the model asked for, or a cloud answer, says nothing", () => {
  const rendered = render(
    view({ localRunModel: { requested: "gpt-5.5", ran: "gpt-5.5" } }),
  );
  expect(rendered.container.textContent).toBe("");
  rendered.rerender(view({}));
  expect(rendered.container.textContent).toBe("");
  rendered.rerender(view(undefined));
  expect(rendered.container.textContent).toBe("");
});
