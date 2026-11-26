import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { SearchChatPreview } = await import("./search-chat-preview");

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

const CHAT = [
  { id: "m1", role: "user", content: "alpha beta alpha beta alpha" },
] as const;

const preview = (searchText: string) => (
  <IntlProvider locale="en" messages={messages} timeZone="UTC">
    <FormattingProvider locale="en" timeZone="UTC">
      <TooltipProvider>
        <SearchChatPreview messages={[...CHAT]} searchText={searchText} />
      </TooltipProvider>
    </FormattingProvider>
  </IntlProvider>
);

const counter = (current: number, total: number) =>
  messages.folio.findReplace.matchCounter
    .replace("{current}", () => String(current))
    .replace("{total}", () => String(total));

test("a new search starts at its first match", async () => {
  const view = render(preview("alpha"));
  await waitFor(() => {
    expect(view.queryByText(counter(1, 3)) === null).toBe(false);
  });

  fireEvent.click(
    view.getByRole("button", { name: messages.common.nextMatch }),
  );
  await waitFor(() => {
    expect(view.queryByText(counter(2, 3)) === null).toBe(false);
  });

  // The second match of the old search is still a match index of the new
  // one; the new search starts over anyway.
  view.rerender(preview("beta"));
  await waitFor(() => {
    expect(view.queryByText(counter(1, 2)) === null).toBe(false);
  });
});
