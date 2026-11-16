import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { createWebTestEnvironment } from "../../../tests/environment.test-fixtures";

GlobalRegistrator.register({ url: "https://app.example.test/law/cases/1" });
const testEnvironment = createWebTestEnvironment({ file: import.meta.path });
testEnvironment.setEnvIfAbsent("VITE_API_URL", "https://api.example.test");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { useWebReaderPresentationAdapters } =
  await import("./web-reader-presentation");

afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const Permalink = () => {
  const { renderPermalinkCopy } = useWebReaderPresentationAdapters();
  return (
    renderPermalinkCopy?.({
      anchorId: "p-7",
      render: ({ copied, copy }) => (
        <button onClick={copy} type="button">
          {copied ? messages.common.copied : messages.common.copyLink}
        </button>
      ),
    }) ?? null
  );
};

test("a block's permalink copies its address and confirms in place", async () => {
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        writes.push(text);
      },
    },
  });
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <Permalink />
      </FormattingProvider>
    </IntlProvider>,
  );

  fireEvent.click(view.getByRole("button", { name: messages.common.copyLink }));

  await waitFor(() =>
    expect(
      view.getByRole("button", { name: messages.common.copied }),
    ).toBeTruthy(),
  );
  expect(writes).toEqual(["https://app.example.test/law/cases/1#p-7"]);
  expect(window.location.hash).toBe("#p-7");
});
