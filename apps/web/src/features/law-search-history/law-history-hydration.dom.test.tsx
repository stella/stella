import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { act, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { renderToString } = await import("react-dom/server");
const { hydrateRoot } = await import("react-dom/client");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { sessionOptions } = await import("@/lib/auth-query-options");
const { LawRecent } = await import("@/routes/law/-law-home/law-recent");

afterAll(unregisterDomEnvironment);

test("law recents hydrate the server placeholder when the browser already read the session", async () => {
  // The server renders before any session read; the browser may answer it
  // ("nobody is signed in") before this part of the page hydrates.
  const serverClient = new QueryClient();
  const browserClient = new QueryClient();
  browserClient.setQueryData(sessionOptions.queryKey, null);
  const tree = (client: InstanceType<typeof QueryClient>) => (
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <LawRecent country="CZE" onSearch={() => undefined} />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>
  );
  const container = document.createElement("div");
  // safe-html: React renderToString output from the local LawRecent fixture.
  container.innerHTML = renderToString(tree(serverClient));
  expect(container.textContent).not.toContain(messages.lawHome.noRecent);
  document.body.append(container);
  const errors: unknown[] = [];
  const root = hydrateRoot(container, tree(browserClient), {
    onRecoverableError: (error) => {
      errors.push(error);
    },
  });
  try {
    await waitFor(() =>
      expect(container.textContent).toContain(messages.lawHome.noRecent),
    );
    expect(errors).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    serverClient.clear();
    browserClient.clear();
  }
});
